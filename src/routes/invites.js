const express = require('express');
const Joi = require('joi');
const { InvitationService } = require('../services/invitationService');
const { EmailService } = require('../services/emailService');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize services
const invitationService = new InvitationService();
const emailService = new EmailService();

/**
 * Accept invitation via token
 */
router.get('/accept/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { firstName, lastName } = req.query;

    if (!token) {
      return res.status(400).send(`
        <html>
          <head><title>Invalid Invitation</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1 style="color: #dc3545;">Invalid Invitation</h1>
            <p>This invitation link is not valid.</p>
          </body>
        </html>
      `);
    }

    const userData = {};
    if (firstName) userData.firstName = firstName.trim();
    if (lastName) userData.lastName = lastName.trim();

    const result = await invitationService.processInviteAcceptance(token, userData);

    if (!result.success) {
      return res.status(400).send(`
        <html>
          <head><title>Invitation Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 20px; border-radius: 8px;">
              <h1 style="margin-top: 0;">Invitation Error</h1>
              <p>${result.error}</p>
            </div>
            <p style="margin-top: 20px;">If you believe this is an error, please contact the person who invited you.</p>
          </body>
        </html>
      `);
    }

    // Success page
    const welcomeHtml = `
      <html>
        <head>
          <title>Welcome to Weekly Recommendations!</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #f8f9fa;">
          <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px;">🎉 Welcome!</h1>
            <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">You've joined Weekly Recommendations!</p>
          </div>
          
          <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #495057; margin-top: 0;">Hi ${result.user.firstName || 'there'}!</h2>
            <p>Thanks to <strong>${result.inviter.firstName || result.inviter.email}</strong> for inviting you!</p>
            
            <h3 style="color: #495057;">How it works:</h3>
            <ul style="color: #666; line-height: 1.8;">
              <li><strong>Every Monday:</strong> You'll receive an email prompt to submit your weekly recommendation</li>
              <li><strong>Reply format:</strong> Include your recommendation, reasons why, and a message to the group</li>
              <li><strong>Sunday evening:</strong> Everyone who submitted gets a roundup with all recommendations</li>
              <li><strong>After 4 weeks:</strong> You'll earn the ability to invite your own friends!</li>
            </ul>
            
            <div style="background: #e7f3ff; padding: 15px; border-radius: 6px; margin: 20px 0;">
              <p style="margin: 0; color: #0066cc;"><strong>Your first email will arrive next Monday!</strong></p>
            </div>
          </div>
          
          <div style="text-align: center; color: #666; font-size: 14px;">
            <p>Welcome to the group! 🎊</p>
            <p style="margin: 0;">Weekly Recommendations Team</p>
          </div>
        </body>
      </html>
    `;

    // Send welcome email
    try {
      await emailService.sendWelcomeEmail(result.user.email, result.user.firstName || 'Friend');
    } catch (emailError) {
      logger.error('Error sending welcome email:', emailError);
      // Don't fail the invitation acceptance if email fails
    }

    logger.info('Invitation accepted successfully:', {
      userId: result.user.id,
      email: result.user.email,
      inviterEmail: result.inviter.email
    });

    return res.send(welcomeHtml);

  } catch (error) {
    logger.error('Error in invite acceptance:', error);
    return res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1 style="color: #dc3545;">Something went wrong</h1>
          <p>There was an error processing your invitation. Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
});

/**
 * Send invitation (for authenticated users)
 */
router.post('/send', async (req, res) => {
  try {
    // Validation schema
    const schema = Joi.object({
      inviterEmail: Joi.string().email().required(),
      inviteeEmail: Joi.string().email().required()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details
      });
    }

    const { inviterEmail, inviteeEmail } = value;

    // Find inviter
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    const inviter = await prisma.user.findUnique({
      where: { email: inviterEmail.toLowerCase() }
    });

    if (!inviter) {
      return res.status(404).json({ error: 'Inviter not found' });
    }

    // Send invitation
    const result = await invitationService.sendInvitation(inviter.id, inviteeEmail);

    if (!result.success) {
      return res.status(400).json({
        error: result.error
      });
    }

    return res.json({
      success: true,
      message: 'Invitation sent successfully',
      inviteId: result.inviteId,
      expiresAt: result.expiresAt,
      invitesRemaining: result.invitesRemaining
    });

  } catch (error) {
    logger.error('Error sending invitation via API:', error);
    return res.status(500).json({
      error: 'Failed to send invitation',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

/**
 * Check invitation status
 */
router.get('/status/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const invite = await prisma.invite.findUnique({
      where: { inviteToken: token },
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
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const isExpired = new Date() > invite.expiresAt;
    const status = isExpired && invite.status === 'pending' ? 'expired' : invite.status;

    return res.json({
      success: true,
      invite: {
        status,
        inviteeEmail: invite.inviteeEmail,
        sentAt: invite.sentAt,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
        isExpired,
        inviter: {
          name: invite.inviter.firstName ? 
            `${invite.inviter.firstName} ${invite.inviter.lastName || ''}`.trim() : 
            invite.inviter.email
        }
      }
    });

  } catch (error) {
    logger.error('Error checking invitation status:', error);
    return res.status(500).json({
      error: 'Failed to check invitation status'
    });
  }
});

/**
 * Get invitation stats (for debugging)
 */
router.get('/stats', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const stats = await invitationService.getInvitationStats();
    return res.json(stats);
  } catch (error) {
    logger.error('Error getting invitation stats:', error);
    return res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * Cleanup expired invitations (for admin/cron)
 */
router.post('/cleanup', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const result = await invitationService.cleanupExpiredInvites();
    return res.json(result);
  } catch (error) {
    logger.error('Error cleaning up invitations:', error);
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

module.exports = router;