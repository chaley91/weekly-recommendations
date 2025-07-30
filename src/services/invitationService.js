const { PrismaClient } = require('@prisma/client');
const { EmailService } = require('./emailService');
const crypto = require('crypto');
const moment = require('moment-timezone');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

class InvitationService {
  constructor() {
    this.emailService = new EmailService();
    this.maxInvitesPerUser = parseInt(process.env.MAX_INVITES_PER_USER) || 5;
    this.inviteExpiryDays = parseInt(process.env.INVITE_EXPIRY_DAYS) || 7;
    this.streakRequired = parseInt(process.env.STREAK_REQUIRED_FOR_INVITE) || 4;
  }

  /**
   * Check if user is eligible to send invitations
   */
  async checkInviteEligibility(userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          streak: true,
          sentInvites: {
            where: {
              status: { in: ['pending', 'accepted'] }
            }
          }
        }
      });

      if (!user || !user.isActive) {
        return { eligible: false, reason: 'User not found or inactive' };
      }

      if (!user.streak) {
        return { eligible: false, reason: 'No submission history' };
      }

      if (user.streak.currentStreak < this.streakRequired) {
        return { 
          eligible: false, 
          reason: `Requires ${this.streakRequired} consecutive weeks (current: ${user.streak.currentStreak})` 
        };
      }

      if (user.sentInvites.length >= this.maxInvitesPerUser) {
        return { 
          eligible: false, 
          reason: `Maximum ${this.maxInvitesPerUser} invites per user reached` 
        };
      }

      return {
        eligible: true,
        invitesUsed: user.sentInvites.length,
        invitesRemaining: this.maxInvitesPerUser - user.sentInvites.length,
        currentStreak: user.streak.currentStreak
      };

    } catch (error) {
      logger.error('Error checking invite eligibility:', error);
      throw error;
    }
  }

  /**
   * Send invitation to new user
   */
  async sendInvitation(inviterId, inviteeEmail) {
    try {
      // Validate inviter eligibility
      const eligibility = await this.checkInviteEligibility(inviterId);
      if (!eligibility.eligible) {
        return { success: false, error: eligibility.reason };
      }

      // Clean and validate email
      const cleanEmail = inviteeEmail.toLowerCase().trim();
      if (!this.isValidEmail(cleanEmail)) {
        return { success: false, error: 'Invalid email address' };
      }

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: cleanEmail }
      });

      if (existingUser) {
        return { success: false, error: 'User is already a member' };
      }

      // Check if there's already a pending invite for this email
      const existingInvite = await prisma.invite.findFirst({
        where: {
          inviteeEmail: cleanEmail,
          status: 'pending',
          expiresAt: {
            gt: new Date()
          }
        }
      });

      if (existingInvite) {
        return { success: false, error: 'Pending invitation already exists for this email' };
      }

      // Generate unique invite token
      const inviteToken = this.generateInviteToken();
      
      // Calculate expiry date
      const expiresAt = moment().add(this.inviteExpiryDays, 'days').toDate();

      // Get inviter info
      const inviter = await prisma.user.findUnique({
        where: { id: inviterId },
        select: {
          firstName: true,
          lastName: true,
          email: true
        }
      });

      // Create invite record
      const invite = await prisma.invite.create({
        data: {
          inviterId,
          inviteeEmail: cleanEmail,
          inviteToken,
          expiresAt
        }
      });

      // Send invitation email
      const inviterName = inviter.firstName ? 
        `${inviter.firstName}${inviter.lastName ? ' ' + inviter.lastName : ''}` : 
        inviter.email;

      await this.emailService.sendInvitation(inviterName, cleanEmail, inviteToken);

      // Update inviter's invite count
      await prisma.user.update({
        where: { id: inviterId },
        data: {
          inviteCount: {
            increment: 1
          }
        }
      });

      logger.info('Invitation sent successfully:', {
        inviterId,
        inviteeEmail: cleanEmail,
        inviteToken,
        expiresAt
      });

      return {
        success: true,
        inviteId: invite.id,
        inviteToken,
        expiresAt,
        invitesRemaining: eligibility.invitesRemaining - 1
      };

    } catch (error) {
      logger.error('Error sending invitation:', error);
      throw error;
    }
  }

  /**
   * Process invitation acceptance
   */
  async processInviteAcceptance(inviteToken, userData = {}) {
    try {
      // Find and validate invite
      const invite = await prisma.invite.findUnique({
        where: { inviteToken },
        include: {
          inviter: {
            select: {
              firstName: true,
              lastName: true,
              email: true
            }
          }
        }
      });

      if (!invite) {
        return { success: false, error: 'Invalid invitation link' };
      }

      if (invite.status !== 'pending') {
        return { success: false, error: 'Invitation already processed' };
      }

      if (new Date() > invite.expiresAt) {
        // Mark as expired
        await prisma.invite.update({
          where: { id: invite.id },
          data: { status: 'expired' }
        });
        return { success: false, error: 'Invitation has expired' };
      }

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: invite.inviteeEmail }
      });

      if (existingUser) {
        // Mark invite as accepted but don't create duplicate user
        await prisma.invite.update({
          where: { id: invite.id },
          data: { 
            status: 'accepted',
            acceptedAt: new Date()
          }
        });
        return { success: false, error: 'User already exists' };
      }

      // Create new user
      const newUser = await prisma.user.create({
        data: {
          email: invite.inviteeEmail,
          firstName: userData.firstName || null,
          lastName: userData.lastName || null,
          isActive: true
        }
      });

      // Create initial streak record
      await prisma.userStreak.create({
        data: {
          userId: newUser.id,
          currentStreak: 0,
          longestStreak: 0,
          canInvite: false
        }
      });

      // Update invite status
      await prisma.invite.update({
        where: { id: invite.id },
        data: { 
          status: 'accepted',
          acceptedAt: new Date()
        }
      });

      logger.info('Invitation accepted successfully:', {
        inviteId: invite.id,
        newUserId: newUser.id,
        userEmail: invite.inviteeEmail
      });

      return {
        success: true,
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName
        },
        inviter: invite.inviter
      };

    } catch (error) {
      logger.error('Error processing invite acceptance:', error);
      throw error;
    }
  }

  /**
   * Check invite eligibility for all users and update records
   */
  async checkAllUsersEligibility() {
    try {
      const users = await prisma.user.findMany({
        where: { isActive: true },
        include: {
          streak: true,
          sentInvites: {
            where: {
              status: { in: ['pending', 'accepted'] }
            }
          }
        }
      });

      let eligibilityUpdates = 0;

      for (const user of users) {
        if (!user.streak) continue;

        const shouldBeEligible = user.streak.currentStreak >= this.streakRequired && 
                                user.sentInvites.length < this.maxInvitesPerUser;
        
        const currentlyEligible = user.streak.canInvite;

        if (shouldBeEligible !== currentlyEligible) {
          await prisma.userStreak.update({
            where: { userId: user.id },
            data: {
              canInvite: shouldBeEligible,
              inviteEligibleSince: shouldBeEligible && !currentlyEligible ? new Date() : user.streak.inviteEligibleSince
            }
          });

          // Send notification if newly eligible
          if (shouldBeEligible && !currentlyEligible) {
            await this.emailService.sendInviteEligibilityNotification(
              user.email,
              user.firstName || 'Friend',
              user.streak.currentStreak
            );
          }

          eligibilityUpdates++;
        }
      }

      logger.info('Checked invite eligibility for all users:', {
        totalUsers: users.length,
        eligibilityUpdates
      });

      return {
        success: true,
        totalUsers: users.length,
        eligibilityUpdates
      };

    } catch (error) {
      logger.error('Error checking all users eligibility:', error);
      throw error;
    }
  }

  /**
   * Get invitation statistics
   */
  async getInvitationStats() {
    try {
      const stats = await prisma.invite.groupBy({
        by: ['status'],
        _count: {
          status: true
        }
      });

      const totalInvites = await prisma.invite.count();
      const recentInvites = await prisma.invite.count({
        where: {
          sentAt: {
            gte: moment().subtract(30, 'days').toDate()
          }
        }
      });

      const eligibleUsers = await prisma.userStreak.count({
        where: { canInvite: true }
      });

      return {
        totalInvites,
        recentInvites,
        eligibleUsers,
        statusBreakdown: stats.reduce((acc, stat) => {
          acc[stat.status] = stat._count.status;
          return acc;
        }, {})
      };

    } catch (error) {
      logger.error('Error getting invitation stats:', error);
      throw error;
    }
  }

  /**
   * Cleanup expired invitations
   */
  async cleanupExpiredInvites() {
    try {
      const expiredInvites = await prisma.invite.updateMany({
        where: {
          status: 'pending',
          expiresAt: {
            lt: new Date()
          }
        },
        data: {
          status: 'expired'
        }
      });

      logger.info('Cleaned up expired invites:', { count: expiredInvites.count });
      return { success: true, expiredCount: expiredInvites.count };

    } catch (error) {
      logger.error('Error cleaning up expired invites:', error);
      throw error;
    }
  }

  /**
   * Validate email address format
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Generate secure invite token
   */
  generateInviteToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Parse invite command from email body
   */
  parseInviteCommand(emailBody) {
    try {
      const invitePattern = /INVITE:\s*([^\s@]+@[^\s@]+\.[^\s@]+)/i;
      const match = emailBody.match(invitePattern);
      
      if (match) {
        return {
          isInviteCommand: true,
          email: match[1].toLowerCase().trim()
        };
      }
      
      return { isInviteCommand: false };
    } catch (error) {
      logger.error('Error parsing invite command:', error);
      return { isInviteCommand: false };
    }
  }

  /**
   * Process invite command from email submission
   */
  async processInviteCommand(fromEmail, inviteeEmail) {
    try {
      // Find the user sending the invite
      const inviter = await prisma.user.findUnique({
        where: { email: fromEmail }
      });

      if (!inviter) {
        return { success: false, error: 'Inviter not found' };
      }

      // Send the invitation
      const result = await this.sendInvitation(inviter.id, inviteeEmail);
      
      if (result.success) {
        // Send confirmation to inviter
        await this.emailService.sendErrorEmail(
          fromEmail,
          'Invitation Sent',
          `Your invitation has been sent to ${inviteeEmail}! They have ${this.inviteExpiryDays} days to accept.`
        );
      } else {
        // Send error to inviter
        await this.emailService.sendErrorEmail(
          fromEmail,
          'Invitation Failed',
          `Could not send invitation to ${inviteeEmail}: ${result.error}`
        );
      }

      return result;

    } catch (error) {
      logger.error('Error processing invite command:', error);
      return { success: false, error: 'Processing failed' };
    }
  }
}

module.exports = { InvitationService };