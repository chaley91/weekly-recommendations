const { PrismaClient } = require('@prisma/client');
const { EmailService } = require('./emailService');
const logger = require('../utils/logger');
const Joi = require('joi');

const prisma = new PrismaClient();

class EmailProcessor {
  constructor() {
    this.emailService = new EmailService();
  }

  /**
   * Parse submission from email body
   * Expected format:
   * RECOMMENDATION: [content]
   * REASON WHY: [content]
   * DIGRESSIONS: [content]
   */
  parseSubmission(emailBody, subject = '') {
    try {
      // Clean the email body
      const cleanBody = this.cleanEmailBody(emailBody);
      
      // Parsing patterns for the three required fields
      const patterns = {
        recommendation: /(?:RECOMMENDATION|RECOMMEND):\s*(.+?)(?=\n\s*(?:REASON\s+WHY|DIGRESSIONS|$))/is,
        reasonWhy: /REASON\s+WHY:\s*(.+?)(?=\n\s*(?:RECOMMENDATION|DIGRESSIONS|$))/is,
        digressions: /DIGRESSIONS:\s*(.+?)(?=\n\s*(?:RECOMMENDATION|REASON\s+WHY|$))/is
      };

      const parsed = {};
      
      for (const [field, pattern] of Object.entries(patterns)) {
        const match = cleanBody.match(pattern);
        if (match) {
          parsed[field] = match[1].trim().replace(/\n\s*/g, ' ');
        }
      }

      logger.info('Parsed submission fields:', {
        hasRecommendation: !!parsed.recommendation,
        hasReasonWhy: !!parsed.reasonWhy,
        hasDigressions: !!parsed.digressions
      });

      return parsed;
    } catch (error) {
      logger.error('Error parsing submission:', error);
      return {};
    }
  }

  /**
   * Clean email body by removing reply chains, signatures, etc.
   */
  cleanEmailBody(body) {
    let cleaned = body;
    
    // Remove common reply chain indicators
    const replyPatterns = [
      /On .+wrote:/gi,
      /From:.+/gi,
      /Sent:.+/gi,
      /To:.+/gi,
      /Subject:.+/gi,
      /-----Original Message-----/gi,
      /________________________________/g,
      /--\s*$/gm, // Signature separator
      /Sent from my iPhone/gi,
      /Sent from my Android/gi
    ];

    for (const pattern of replyPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // Remove excessive whitespace
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Validate parsed submission data
   */
  validateSubmissionFormat(parsedData) {
    const schema = Joi.object({
      recommendation: Joi.string().min(5).max(500).required(),
      reasonWhy: Joi.string().min(10).max(1000).required(),
      digressions: Joi.string().min(5).max(1000).required()
    });

    const { error, value } = schema.validate(parsedData);
    
    if (error) {
      logger.warn('Validation error:', error.details);
      return { valid: false, errors: error.details };
    }

    return { valid: true, data: value };
  }

  /**
   * Process incoming email from SendGrid webhook
   */
  async processInboundEmail(sendGridPayload) {
    try {
      const { from, to, subject, text, html } = sendGridPayload;
      
      logger.info('Processing inbound email:', { 
        from, 
        to, 
        subject: subject?.substring(0, 50) 
      });

      // Extract sender email
      const senderEmail = this.extractEmail(from);
      if (!senderEmail) {
        logger.warn('Could not extract sender email from:', from);
        return { success: false, error: 'Invalid sender email' };
      }

      // Check if user exists
      const user = await prisma.user.findUnique({
        where: { email: senderEmail },
        include: { streak: true }
      });

      if (!user || !user.isActive) {
        logger.warn('Email from unknown or inactive user:', senderEmail);
        await this.emailService.sendErrorEmail(
          senderEmail, 
          'Unknown User', 
          'You are not registered for the weekly recommendations system.'
        );
        return { success: false, error: 'Unknown user' };
      }

      // Get current active week
      const currentWeek = await prisma.week.findFirst({
        where: { status: 'open' },
        orderBy: { createdAt: 'desc' }
      });

      if (!currentWeek) {
        logger.warn('No active week found for submission');
        await this.emailService.sendErrorEmail(
          senderEmail,
          'No Active Week',
          'There is no active week for submissions right now.'
        );
        return { success: false, error: 'No active week' };
      }

      // Check if already submitted this week
      const existingSubmission = await prisma.submission.findUnique({
        where: {
          userId_weekId: {
            userId: user.id,
            weekId: currentWeek.id
          }
        }
      });

      if (existingSubmission) {
        logger.warn('User already submitted this week:', { userId: user.id, weekId: currentWeek.id });
        await this.emailService.sendErrorEmail(
          senderEmail,
          'Already Submitted',
          'You have already submitted a recommendation for this week.'
        );
        return { success: false, error: 'Already submitted' };
      }

      // Parse the submission
      const emailBody = text || html || '';
      const parsedData = this.parseSubmission(emailBody, subject);
      
      // Validate submission format
      const validation = this.validateSubmissionFormat(parsedData);
      if (!validation.valid) {
        logger.warn('Invalid submission format:', validation.errors);
        await this.emailService.sendSubmissionFormatError(senderEmail, validation.errors);
        return { success: false, error: 'Invalid format', details: validation.errors };
      }

      // Save submission
      const submission = await prisma.submission.create({
        data: {
          userId: user.id,
          weekId: currentWeek.id,
          recommendation: validation.data.recommendation,
          reasons: validation.data.reasonWhy,
          message: validation.data.digressions
        }
      });

      // Update user streak
      await this.updateUserStreak(user.id, currentWeek.weekNumber);

      // Send confirmation email
      await this.emailService.sendSubmissionConfirmation(
        senderEmail,
        user.firstName || 'Friend',
        validation.data,
        currentWeek.weekNumber
      );

      logger.info('Submission processed successfully:', { 
        userId: user.id, 
        weekId: currentWeek.id,
        submissionId: submission.id 
      });

      return { success: true, submissionId: submission.id };

    } catch (error) {
      logger.error('Error processing inbound email:', error);
      return { success: false, error: 'Processing failed' };
    }
  }

  /**
   * Extract email address from various formats
   */
  extractEmail(emailString) {
    if (!emailString) return null;
    
    // Handle formats like "Name <email@domain.com>" or just "email@domain.com"
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
    const match = emailString.match(emailRegex);
    
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Update user's submission streak
   */
  async updateUserStreak(userId, currentWeekNumber) {
    try {
      const userStreak = await prisma.userStreak.findUnique({
        where: { userId }
      });

      if (!userStreak) {
        // Create initial streak record
        await prisma.userStreak.create({
          data: {
            userId,
            currentStreak: 1,
            longestStreak: 1,
            lastSubmissionWeek: currentWeekNumber,
            canInvite: false
          }
        });
        return;
      }

      // Calculate if this is consecutive
      const isConsecutive = this.isConsecutiveWeek(
        userStreak.lastSubmissionWeek, 
        currentWeekNumber
      );

      const newCurrentStreak = isConsecutive ? userStreak.currentStreak + 1 : 1;
      const newLongestStreak = Math.max(userStreak.longestStreak, newCurrentStreak);
      
      // Check if user can now invite (4+ consecutive weeks)
      const canInvite = newCurrentStreak >= (process.env.STREAK_REQUIRED_FOR_INVITE || 4);
      const inviteEligibleSince = canInvite && !userStreak.canInvite ? new Date() : userStreak.inviteEligibleSince;

      await prisma.userStreak.update({
        where: { userId },
        data: {
          currentStreak: newCurrentStreak,
          longestStreak: newLongestStreak,
          lastSubmissionWeek: currentWeekNumber,
          canInvite,
          inviteEligibleSince
        }
      });

      // Notify user if they just became eligible to invite
      if (canInvite && !userStreak.canInvite) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        await this.emailService.sendInviteEligibilityNotification(
          user.email, 
          user.firstName || 'Friend',
          newCurrentStreak
        );
      }

      logger.info('Updated user streak:', { 
        userId, 
        currentWeekNumber,
        newCurrentStreak,
        canInvite 
      });

    } catch (error) {
      logger.error('Error updating user streak:', error);
    }
  }

  /**
   * Check if two week numbers are consecutive
   */
  isConsecutiveWeek(lastWeek, currentWeek) {
    if (!lastWeek) return false;
    
    // Simple consecutive check - in a real implementation,
    // you'd want to handle year boundaries properly
    return currentWeek === lastWeek + 1;
  }
}

module.exports = { EmailProcessor };