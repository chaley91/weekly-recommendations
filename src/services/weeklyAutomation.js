// Calculate start date (thisconst { PrismaClient } = require('@prisma/client');
const { EmailService } = require('./emailService');
const moment = require('moment-timezone');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

class WeeklyAutomation {
  constructor() {
    this.emailService = new EmailService();
    this.timezone = process.env.TIMEZONE || 'America/New_York';
  }

  /**
   * Start a new week - create week record and send prompt emails
   */
  async startNewWeek() {
    try {
      logger.info('Starting new week process');

      // Check if there's already an open week
      const existingOpenWeek = await prisma.week.findFirst({
        where: { status: 'open' }
      });

      if (existingOpenWeek) {
        logger.warn('There is already an open week, skipping new week creation');
        return { success: false, error: 'Week already open' };
      }

      // Calculate week number (YYYYWW format)
      const now = moment.tz(this.timezone);
      const weekNumber = parseInt(now.format('YYYY')) * 100 + now.week();
      
      // Calculate start date (this Thursday) and deadline (next Sunday)
      const startDate = now.clone().day(4).startOf('day').toDate(); // Thursday
      const deadline = now.clone().day(7).hour(parseInt(process.env.WEEKLY_DEADLINE_HOUR) || 18)
        .minute(0)
        .second(0)
        .toDate(); // Sunday

      // Create new week record
      const newWeek = await prisma.week.create({
        data: {
          weekNumber,
          startDate,
          deadline,
          status: 'open'
        }
      });

      logger.info('Created new week:', { 
        weekId: newWeek.id, 
        weekNumber,
        deadline: newWeek.deadline 
      });

      // Get all active users
      const activeUsers = await prisma.user.findMany({
        where: { isActive: true },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true
        }
      });

      if (activeUsers.length === 0) {
        logger.warn('No active users found for weekly prompt');
        return { success: true, week: newWeek, emailsSent: 0 };
      }

      // Send weekly prompt emails
      const emailResult = await this.emailService.sendWeeklyPrompt(activeUsers, {
        weekNumber,
        deadline: newWeek.deadline
      });

      logger.info('New week started successfully:', {
        weekId: newWeek.id,
        weekNumber,
        usersEmailed: emailResult.count
      });

      return {
        success: true,
        week: newWeek,
        emailsSent: emailResult.count
      };

    } catch (error) {
      logger.error('Error starting new week:', error);
      throw error;
    }
  }

  /**
   * Close the current week and send compilation
   */
  async closeWeekAndCompile() {
    try {
      logger.info('Starting weekly compilation process');

      // Find the current open week
      const currentWeek = await prisma.week.findFirst({
        where: { status: 'open' },
        include: {
          submissions: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
      });

      if (!currentWeek) {
        logger.warn('No open week found for compilation');
        return { success: false, error: 'No open week' };
      }

      // Close the week
      await prisma.week.update({
        where: { id: currentWeek.id },
        data: { status: 'closed' }
      });

      logger.info('Week closed:', { 
        weekId: currentWeek.id, 
        submissionCount: currentWeek.submissions.length 
      });

      // If no submissions, just mark as compiled and return
      if (currentWeek.submissions.length === 0) {
        await prisma.week.update({
          where: { id: currentWeek.id },
          data: { status: 'compiled' }
        });

        logger.info('No submissions for week, marked as compiled');
        return { 
          success: true, 
          weekNumber: currentWeek.weekNumber,
          submissionCount: 0,
          emailsSent: 0 
        };
      }

      // Get unique participants (users who submitted)
      const participants = currentWeek.submissions.map(sub => sub.user);
      
      // Send compilation email to participants
      const emailResult = await this.emailService.sendWeeklyCompilation(
        participants,
        currentWeek.submissions,
        currentWeek.weekNumber
      );

      // Mark week as compiled
      await prisma.week.update({
        where: { id: currentWeek.id },
        data: { status: 'compiled' }
      });

      // Update user streaks for all users (including those who didn't submit)
      await this.updateAllUserStreaks(currentWeek.weekNumber, currentWeek.submissions);

      logger.info('Weekly compilation completed successfully:', {
        weekId: currentWeek.id,
        weekNumber: currentWeek.weekNumber,
        submissionCount: currentWeek.submissions.length,
        participantsEmailed: emailResult.count
      });

      return {
        success: true,
        weekNumber: currentWeek.weekNumber,
        submissionCount: currentWeek.submissions.length,
        emailsSent: emailResult.count
      };

    } catch (error) {
      logger.error('Error compiling weekly submissions:', error);
      throw error;
    }
  }

  /**
   * Update streaks for all users based on this week's submissions
   */
  async updateAllUserStreaks(weekNumber, submissions) {
    try {
      // Get all active users
      const allUsers = await prisma.user.findMany({
        where: { isActive: true },
        include: { streak: true }
      });

      // Create a set of user IDs who submitted this week
      const submittedUserIds = new Set(submissions.map(sub => sub.userId));

      for (const user of allUsers) {
        const didSubmit = submittedUserIds.has(user.id);
        await this.updateUserStreak(user, weekNumber, didSubmit);
      }

      logger.info('Updated streaks for all users', { 
        totalUsers: allUsers.length,
        submitted: submittedUserIds.size 
      });

    } catch (error) {
      logger.error('Error updating user streaks:', error);
    }
  }

  /**
   * Update individual user streak
   */
  async updateUserStreak(user, weekNumber, didSubmit) {
    try {
      if (!user.streak) {
        // Create initial streak record
        await prisma.userStreak.create({
          data: {
            userId: user.id,
            currentStreak: didSubmit ? 1 : 0,
            longestStreak: didSubmit ? 1 : 0,
            lastSubmissionWeek: didSubmit ? weekNumber : null,
            canInvite: false
          }
        });
        return;
      }

      let newCurrentStreak;
      if (didSubmit) {
        // Check if this extends their streak
        const isConsecutive = this.isConsecutiveWeek(user.streak.lastSubmissionWeek, weekNumber);
        newCurrentStreak = isConsecutive ? user.streak.currentStreak + 1 : 1;
      } else {
        // Reset streak if they didn't submit
        newCurrentStreak = 0;
      }

      const newLongestStreak = Math.max(user.streak.longestStreak, newCurrentStreak);
      
      // Check if user can now invite (4+ consecutive weeks and hasn't maxed out invites)
      const streakRequired = parseInt(process.env.STREAK_REQUIRED_FOR_INVITE) || 4;
      const maxInvites = parseInt(process.env.MAX_INVITES_PER_USER) || 5;
      const canInvite = newCurrentStreak >= streakRequired && user.inviteCount < maxInvites;
      
      const inviteEligibleSince = canInvite && !user.streak.canInvite ? new Date() : user.streak.inviteEligibleSince;

      await prisma.userStreak.update({
        where: { userId: user.id },
        data: {
          currentStreak: newCurrentStreak,
          longestStreak: newLongestStreak,
          lastSubmissionWeek: didSubmit ? weekNumber : user.streak.lastSubmissionWeek,
          canInvite,
          inviteEligibleSince
        }
      });

      // Notify user if they just became eligible to invite
      if (canInvite && !user.streak.canInvite) {
        await this.emailService.sendInviteEligibilityNotification(
          user.email,
          user.firstName || 'Friend',
          newCurrentStreak
        );
      }

    } catch (error) {
      logger.error('Error updating user streak:', { userId: user.id, error });
    }
  }

  /**
   * Check if two week numbers are consecutive
   */
  isConsecutiveWeek(lastWeek, currentWeek) {
    if (!lastWeek) return false;
    
    // Handle year boundaries properly
    const lastYear = Math.floor(lastWeek / 100);
    const lastWeekNum = lastWeek % 100;
    const currentYear = Math.floor(currentWeek / 100);
    const currentWeekNum = currentWeek % 100;
    
    // Same year - simple consecutive check
    if (lastYear === currentYear) {
      return currentWeekNum === lastWeekNum + 1;
    }
    
    // Year boundary - check if last week was week 52/53 and current is week 1
    if (currentYear === lastYear + 1) {
      return (lastWeekNum >= 52 && currentWeekNum === 1);
    }
    
    return false;
  }

  /**
   * Get current week status
   */
  async getCurrentWeekStatus() {
    try {
      const currentWeek = await prisma.week.findFirst({
        where: { status: 'open' },
        include: {
          submissions: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true
                }
              }
            }
          }
        }
      });

      if (!currentWeek) {
        return { hasActiveWeek: false };
      }

      const now = moment.tz(this.timezone);
      const deadline = moment(currentWeek.deadline).tz(this.timezone);
      const isExpired = now.isAfter(deadline);

      return {
        hasActiveWeek: true,
        week: currentWeek,
        submissionCount: currentWeek.submissions.length,
        deadline: currentWeek.deadline,
        isExpired,
        timeUntilDeadline: isExpired ? null : deadline.diff(now, 'hours')
      };

    } catch (error) {
      logger.error('Error getting current week status:', error);
      throw error;
    }
  }

  /**
   * Manually trigger week start (for admin/testing)
   */
  async manualStartWeek() {
    logger.info('Manual week start triggered');
    return await this.startNewWeek();
  }

  /**
   * Manually trigger compilation (for admin/testing)
   */
  async manualCompileWeek(weekId = null) {
    logger.info('Manual compilation triggered', { weekId });
    
    if (weekId) {
      // Compile specific week
      const week = await prisma.week.findUnique({
        where: { id: weekId },
        include: {
          submissions: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
      });

      if (!week) {
        return { success: false, error: 'Week not found' };
      }

      if (week.status === 'compiled') {
        return { success: false, error: 'Week already compiled' };
      }

      // Send compilation
      if (week.submissions.length > 0) {
        const participants = week.submissions.map(sub => sub.user);
        await this.emailService.sendWeeklyCompilation(
          participants,
          week.submissions,
          week.weekNumber
        );
      }

      // Mark as compiled
      await prisma.week.update({
        where: { id: weekId },
        data: { status: 'compiled' }
      });

      return {
        success: true,
        weekNumber: week.weekNumber,
        submissionCount: week.submissions.length
      };
    } else {
      // Compile current open week
      return await this.closeWeekAndCompile();
    }
  }

  /**
   * Send reminder email to users who haven't submitted
   */
  async sendReminders() {
    try {
      const currentWeek = await prisma.week.findFirst({
        where: { status: 'open' },
        include: {
          submissions: true
        }
      });

      if (!currentWeek) {
        logger.info('No active week for reminders');
        return { success: false, error: 'No active week' };
      }

      // Check if deadline is within 24 hours
      const now = moment.tz(this.timezone);
      const deadline = moment(currentWeek.deadline).tz(this.timezone);
      const hoursUntilDeadline = deadline.diff(now, 'hours');

      if (hoursUntilDeadline > 24) {
        logger.info('Deadline too far away for reminders', { hoursUntilDeadline });
        return { success: false, error: 'Too early for reminders' };
      }

      // Get users who haven't submitted
      const submittedUserIds = currentWeek.submissions.map(sub => sub.userId);
      const usersWhoHaventSubmitted = await prisma.user.findMany({
        where: {
          isActive: true,
          id: {
            notIn: submittedUserIds
          }
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true
        }
      });

      if (usersWhoHaventSubmitted.length === 0) {
        logger.info('All users have submitted, no reminders needed');
        return { success: true, remindersSent: 0 };
      }

      // Send reminder emails
      const formattedDeadline = deadline.format('dddd [at] h:mm A');
      const reminderEmails = usersWhoHaventSubmitted.map(user => ({
        to: user.email,
        from: {
          email: process.env.FROM_EMAIL,
          name: process.env.FROM_NAME
        },
        replyTo: process.env.SUBMIT_EMAIL,
        subject: `Reminder: Week ${currentWeek.weekNumber} deadline in ${hoursUntilDeadline} hours`,
        html: this.generateReminderTemplate(
          user.firstName || 'Friend',
          currentWeek.weekNumber,
          formattedDeadline,
          hoursUntilDeadline
        )
      }));

      await this.emailService.sgMail.send(reminderEmails);

      logger.info('Reminder emails sent', {
        weekNumber: currentWeek.weekNumber,
        remindersSent: usersWhoHaventSubmitted.length
      });

      return {
        success: true,
        remindersSent: usersWhoHaventSubmitted.length
      };

    } catch (error) {
      logger.error('Error sending reminders:', error);
      throw error;
    }
  }

  /**
   * Generate reminder email template
   */
  generateReminderTemplate(name, weekNumber, deadline, hoursLeft) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reminder: Week ${weekNumber} Deadline Soon</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 20px; border-radius: 8px; margin-bottom: 25px; text-align: center;">
        <h2 style="margin: 0 0 10px 0;">⏰ Deadline Reminder</h2>
        <p style="margin: 0; font-size: 18px;"><strong>${hoursLeft} hours left</strong> to submit for Week ${weekNumber}!</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <h3 style="margin-top: 0; color: #495057;">Hey ${name}!</h3>
        <p>Just a friendly reminder that the deadline for Week ${weekNumber} recommendations is coming up:</p>
        
        <div style="text-align: center; font-size: 18px; color: #856404; margin: 20px 0;">
            <strong>Deadline: ${deadline}</strong>
        </div>
        
        <p>Reply to this email with your submission in this format:</p>
        
        <div style="background: white; padding: 15px; border-left: 4px solid #667eea; margin: 15px 0; border-radius: 4px;">
            <p style="margin: 5px 0;"><strong>RECOMMENDATION:</strong> [What you're recommending]</p>
            <p style="margin: 5px 0;"><strong>REASON WHY:</strong> [Why you recommend it]</p>
            <p style="margin: 5px 0;"><strong>DIGRESSIONS:</strong> [Life updates, thoughts, or silly messages]</p>
        </div>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  /**
   * Clean up old weeks and data
   */
  async cleanupOldData(weeksToKeep = 12) {
    try {
      const cutoffDate = moment.tz(this.timezone).subtract(weeksToKeep, 'weeks').toDate();
      
      // Delete old weeks and their submissions
      const deletedWeeks = await prisma.week.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate
          }
        }
      });

      // Clean up expired invites
      const deletedInvites = await prisma.invite.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          },
          status: 'pending'
        }
      });

      logger.info('Cleanup completed', {
        deletedWeeks: deletedWeeks.count,
        deletedInvites: deletedInvites.count
      });

      return {
        success: true,
        deletedWeeks: deletedWeeks.count,
        deletedInvites: deletedInvites.count
      };

    } catch (error) {
      logger.error('Error during cleanup:', error);
      throw error;
    }
  }
}

module.exports = { WeeklyAutomation };
  async manualStartWeek() {
    logger.info('Manual week start triggered');
    return await this.startNewWeek();
  }

  /**
   * Manually trigger compilation (for admin/testing)
   */
  async manualCompileWeek(weekId = null) {
    logger.info('Manual compilation triggered', { weekId });
    
    if (weekId) {
      // Compile specific week
      const week = await prisma.week.findUnique({
        where: { id: weekId },
        include: {
          submissions: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
      });

      if (!week) {
        return { success: false, error: 'Week not found' };
      }

      if (week.status === 'compiled') {
        return { success: false, error: 'Week already compiled' };
      }

      // Send compilation
      if (week.submissions.length > 0) {
        const participants = week.submissions.map(sub => sub.user);
        await this.emailService.sendWeeklyCompilation(
          participants,
          week.submissions,
          week.weekNumber
        );
      }

      // Mark as compiled
      await prisma.week.update({
        where: { id: weekId },
        data: { status: 'compiled' }
      });

      return {
        success: true,
        weekNumber: week.weekNumber,
        submissionCount: week.submissions.length
      };
    } else {
      // Compile current open week
      return await this.closeWeekAndCompile();
    }
  }

  /**
   * Send reminder email to users who haven't submitted
   */
  async sendReminders() {
    try {
      const currentWeek = await prisma.week.findFirst({
        where: { status: 'open' },
        include: {
          submissions: true
        }
      });

      if (!currentWeek) {
        logger.info('No active week for reminders');
        return { success: false, error: 'No active week' };
      }

      // Check if deadline is within 24 hours
      const now = moment.tz(this.timezone);
      const deadline = moment(currentWeek.deadline).tz(this.timezone);
      const hoursUntilDeadline = deadline.diff(now, 'hours');

      if (hoursUntilDeadline > 24) {
        logger.info('Deadline too far away for reminders', { hoursUntilDeadline });
        return { success: false, error: 'Too early for reminders' };
      }

      // Get users who haven't submitted
      const submittedUserIds = currentWeek.submissions.map(sub => sub.userId);
      const usersWhoHaventSubmitted = await prisma.user.findMany({
        where: {
          isActive: true,
          id: {
            notIn: submittedUserIds
          }
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true
        }
      });

      if (usersWhoHaventSubmitted.length === 0) {
        logger.info('All users have submitted, no reminders needed');
        return { success: true, remindersSent: 0 };
      }

      // Send reminder emails
      const formattedDeadline = deadline.format('dddd [at] h:mm A');
      const reminderEmails = usersWhoHaventSubmitted.map(user => ({
        to: user.email,
        from: {
          email: process.env.FROM_EMAIL,
          name: process.env.FROM_NAME
        },
        replyTo: process.env.SUBMIT_EMAIL,
        subject: `Reminder: Week ${currentWeek.weekNumber} deadline in ${hoursUntilDeadline} hours`,
        html: this.generateReminderTemplate(
          user.firstName || 'Friend',
          currentWeek.weekNumber,
          formattedDeadline,
          hoursUntilDeadline
        )
      }));

      await this.emailService.sgMail.send(reminderEmails);

      logger.info('Reminder emails sent', {
        weekNumber: currentWeek.weekNumber,
        remindersSent: usersWhoHaventSubmitted.length
      });

      return {
        success: true,
        remindersSent: usersWhoHaventSubmitted.length
      };

    } catch (error) {
      logger.error('Error sending reminders:', error);
      throw error;
    }
  }

  /**
   * Generate reminder email template
   */
  generateReminderTemplate(name, weekNumber, deadline, hoursLeft) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reminder: Week ${weekNumber} Deadline Soon</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 20px; border-radius: 8px; margin-bottom: 25px; text-align: center;">
        <h2 style="margin: 0 0 10px 0;">⏰ Deadline Reminder</h2>
        <p style="margin: 0; font-size: 18px;"><strong>${hoursLeft} hours left</strong> to submit for Week ${weekNumber}!</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <h3 style="margin-top: 0; color: #495057;">Hey ${name}!</h3>
        <p>Just a friendly reminder that the deadline for Week ${weekNumber} recommendations is coming up:</p>
        
        <div style="text-align: center; font-size: 18px; color: #856404; margin: 20px 0;">
            <strong>Deadline: ${deadline}</strong>
        </div>
        
        <p>Reply to this email with your submission in this format:</p>
        
        <div style="background: white; padding: 15px; border-left: 4px solid #667eea; margin: 15px 0; border-radius: 4px;">
            <p style="margin: 5px 0;"><strong>RECOMMENDATION:</strong> [What you're recommending]</p>
            <p style="margin: 5px 0;"><strong>REASONS:</strong> [Why you recommend it]</p>
            <p style="margin: 5px 0;"><strong>MESSAGE:</strong> [Short note to the group]</p>
        </div>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  /**
   * Clean up old weeks and data
   */
  async cleanupOldData(weeksToKeep = 12) {
    try {
      const cutoffDate = moment.tz(this.timezone).subtract(weeksToKeep, 'weeks').toDate();
      
      // Delete old weeks and their submissions
      const deletedWeeks = await prisma.week.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate
          }
        }
      });

      // Clean up expired invites
      const deletedInvites = await prisma.invite.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          },
          status: 'pending'
        }
      });

      logger.info('Cleanup completed', {
        deletedWeeks: deletedWeeks.count,
        deletedInvites: deletedInvites.count
      });

      return {
        success: true,
        deletedWeeks: deletedWeeks.count,
        deletedInvites: deletedInvites.count
      };

    } catch (error) {
      logger.error('Error during cleanup:', error);
      throw error;
    }
  }
}

module.exports = { WeeklyAutomation };