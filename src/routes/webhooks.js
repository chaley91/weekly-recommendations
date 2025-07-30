const express = require('express');
const crypto = require('crypto');
const { EmailProcessor } = require('../services/emailProcessor');
const { InvitationService } = require('../services/invitationService');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize services
const emailProcessor = new EmailProcessor();
const invitationService = new InvitationService();

/**
 * Verify SendGrid webhook signature
 */
function verifyWebhookSignature(req, res, next) {
  const signature = req.get('X-Sendgrid-Signature');
  const timestamp = req.get('X-Sendgrid-Timestamp');
  const body = req.rawBody || req.body;

  if (!signature || !timestamp) {
    logger.warn('Missing SendGrid signature headers');
    return res.status(401).json({ error: 'Missing signature headers' });
  }

  if (process.env.SENDGRID_WEBHOOK_SECRET) {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.SENDGRID_WEBHOOK_SECRET)
        .update(timestamp + body.toString())
        .digest('base64');

      // SendGrid sends signature with version prefix like "v1="
      const actualSignature = signature.split(',')[0].replace('v1=', '');

      if (expectedSignature !== actualSignature) {
        logger.warn('Invalid SendGrid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (error) {
      logger.error('Error verifying webhook signature:', error);
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  next();
}

/**
 * Parse SendGrid inbound email payload
 */
function parseInboundEmail(payload) {
  try {
    // SendGrid sends multipart data, but we'll handle the JSON format
    if (typeof payload === 'string') {
      return JSON.parse(payload);
    }
    return payload;
  } catch (error) {
    logger.error('Error parsing inbound email payload:', error);
    return null;
  }
}

/**
 * Handle inbound email webhook from SendGrid
 */
router.post('/inbound-email', verifyWebhookSignature, async (req, res) => {
  try {
    logger.info('Received inbound email webhook');

    // Parse the payload
    const emailData = parseInboundEmail(req.body);
    if (!emailData) {
      logger.error('Could not parse email payload');
      return res.status(400).json({ error: 'Invalid payload format' });
    }

    // Handle multiple emails in batch
    const emails = Array.isArray(emailData) ? emailData : [emailData];
    const results = [];

    for (const email of emails) {
      try {
        const { from, to, subject, text, html } = email;
        
        logger.info('Processing email:', { 
          from: from?.substring(0, 50), 
          to: to?.substring(0, 50),
          subject: subject?.substring(0, 100)
        });

        // Extract sender email
        const senderEmail = emailProcessor.extractEmail(from);
        if (!senderEmail) {
          logger.warn('Could not extract sender email:', from);
          results.push({ email: from, success: false, error: 'Invalid sender' });
          continue;
        }

        // Check if this is an invite command
        const emailBody = text || html || '';
        const inviteCommand = invitationService.parseInviteCommand(emailBody);
        
        if (inviteCommand.isInviteCommand) {
          // Process invite command
          logger.info('Processing invite command:', { 
            from: senderEmail, 
            invitee: inviteCommand.email 
          });
          
          const inviteResult = await invitationService.processInviteCommand(
            senderEmail, 
            inviteCommand.email
          );
          
          results.push({
            email: senderEmail,
            success: inviteResult.success,
            type: 'invite',
            error: inviteResult.error || null
          });
        } else {
          // Process regular submission
          const result = await emailProcessor.processInboundEmail(email);
          results.push({
            email: senderEmail,
            success: result.success,
            type: 'submission',
            submissionId: result.submissionId || null,
            error: result.error || null
          });
        }

      } catch (emailError) {
        logger.error('Error processing individual email:', emailError);
        results.push({
          email: 'unknown',
          success: false,
          error: 'Processing failed'
        });
      }
    }

    // Log summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    logger.info('Inbound email processing complete:', {
      total: results.length,
      successful,
      failed
    });

    return res.status(200).json({
      success: true,
      processed: results.length,
      successful,
      failed,
      results
    });

  } catch (error) {
    logger.error('Error in inbound email webhook:', error);
    return res.status(500).json({
      error: 'Webhook processing failed',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

/**
 * Test endpoint for webhook functionality
 */
router.post('/test-email', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const { from, to, subject, text, html } = req.body;

    if (!from || !text) {
      return res.status(400).json({ error: 'Missing required fields: from, text' });
    }

    const testEmail = {
      from,
      to: to || 'submit@weeklyrecs.com',
      subject: subject || 'Test Submission',
      text,
      html: html || text
    };

    const result = await emailProcessor.processInboundEmail(testEmail);

    return res.json({
      success: true,
      result
    });

  } catch (error) {
    logger.error('Error in test email endpoint:', error);
    return res.status(500).json({
      error: 'Test failed',
      message: error.message
    });
  }
});

/**
 * Health check for webhook endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'webhook',
    timestamp: new Date().toISOString()
  });
});

/**
 * Get webhook configuration info (for debugging)
 */
router.get('/config', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json({
    hasWebhookSecret: !!process.env.SENDGRID_WEBHOOK_SECRET,
    submitEmail: process.env.SUBMIT_EMAIL || 'submit@weeklyrecs.com',
    fromEmail: process.env.FROM_EMAIL || 'noreply@weeklyrecs.com',
    baseUrl: process.env.BASE_URL || 'https://yourapp.railway.app'
  });
});

module.exports = router;