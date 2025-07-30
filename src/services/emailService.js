const sgMail = require('@sendgrid/mail');
const moment = require('moment-timezone');
const logger = require('../utils/logger');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

class EmailService {
  constructor() {
    this.fromEmail = process.env.FROM_EMAIL || 'noreply@weeklyrecs.com';
    this.fromName = process.env.FROM_NAME || 'Weekly Recommendations';
    this.timezone = process.env.TIMEZONE || 'America/New_York';
  }

  /**
   * Send weekly prompt email to all active users (individually)
   */
  async sendWeeklyPrompt(users, weekData) {
    try {
      const { weekNumber, deadline } = weekData;
      const formattedDeadline = moment(deadline).tz(this.timezone).format('dddd, MMMM Do [at] h:mm A');
      
      const emailPromises = users.map(async (user) => {
        const email = {
          to: user.email,
          from: {
            email: this.fromEmail,
            name: this.fromName
          },
          replyTo: process.env.SUBMIT_EMAIL || 'submit@weeklyrecs.com',
          subject: `Week ${weekNumber} Recommendations - Due ${moment(deadline).tz(this.timezone).format('M/D')}`,
          html: this.generateWeeklyPromptTemplate(user.firstName || 'Friend', weekNumber, formattedDeadline),
          text: this.generateWeeklyPromptTextTemplate(user.firstName || 'Friend', weekNumber, formattedDeadline)
        };

        try {
          await sgMail.send(email);
          logger.info(`Weekly prompt sent to ${user.email}`);
          return { success: true, email: user.email };
        } catch (error) {
          logger.error(`Failed to send prompt to ${user.email}:`, error);
          return { success: false, email: user.email, error: error.message };
        }
      });

      const results = await Promise.allSettled(emailPromises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.filter(r => r.status === 'rejected' || !r.value.success).length;

      logger.info(`Weekly prompt batch complete for week ${weekNumber}: ${successful} sent, ${failed} failed`);
      
      return { success: true, count: successful, failed };
    } catch (error) {
      logger.error('Error sending weekly prompt batch:', error);
      throw error;
    }
  }

  /**
   * Send compilation email to users who submitted
   */
  async sendWeeklyCompilation(participants, submissions, weekNumber) {
    try {
      const emails = participants.map(user => ({
        to: user.email,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: `Week ${weekNumber} Recommendations Roundup - ${submissions.length} submissions`,
        html: this.generateCompilationTemplate(user.firstName || 'Friend', submissions, weekNumber),
        text: this.generateCompilationTextTemplate(submissions, weekNumber)
      }));

      await sgMail.send(emails);
      logger.info(`Compilation sent to ${participants.length} participants for week ${weekNumber}`);
      
      return { success: true, count: participants.length };
    } catch (error) {
      logger.error('Error sending compilation:', error);
      throw error;
    }
  }

  /**
   * Send submission confirmation
   */
  async sendSubmissionConfirmation(email, name, submissionData, weekNumber) {
    try {
      const msg = {
        to: email,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: `Submission Confirmed - Week ${weekNumber}`,
        html: this.generateConfirmationTemplate(name, submissionData, weekNumber),
        text: this.generateConfirmationTextTemplate(name, submissionData, weekNumber)
      };

      await sgMail.send(msg);
      logger.info(`Confirmation sent to ${email} for week ${weekNumber}`);
    } catch (error) {
      logger.error('Error sending confirmation:', error);
      throw error;
    }
  }

  /**
   * Send error email for various issues
   */
  async sendErrorEmail(email, errorType, message) {
    try {
      const msg = {
        to: email,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: `Submission Issue - ${errorType}`,
        html: this.generateErrorTemplate(errorType, message),
        text: `Hi there!\n\nThere was an issue with your submission: ${message}\n\nIf you need help, please reply to this email.\n\nBest,\nWeekly Recommendations Team`
      };

      await sgMail.send(msg);
      logger.info(`Error email sent to ${email}: ${errorType}`);
    } catch (error) {
      logger.error('Error sending error email:', error);
    }
  }

  /**
   * Send submission format error with specific guidance
   */
  async sendSubmissionFormatError(email, validationErrors) {
    try {
      const errorMessages = validationErrors.map(err => err.message).join(', ');
      
      const msg = {
        to: email,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: 'Submission Format Error',
        html: this.generateFormatErrorTemplate(errorMessages),
        text: this.generateFormatErrorTextTemplate(errorMessages)
      };

      await sgMail.send(msg);
      logger.info(`Format error email sent to ${email}`);
    } catch (error) {
      logger.error('Error sending format error email:', error);
    }
  }

  /**
   * Send invitation email
   */
  async sendInvitation(inviterName, inviteeEmail, inviteToken) {
    try {
      const acceptUrl = `${process.env.BASE_URL}/api/invite/accept/${inviteToken}`;
      
      const msg = {
        to: inviteeEmail,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: `${inviterName} invited you to Weekly Recommendations!`,
        html: this.generateInvitationTemplate(inviterName, acceptUrl),
        text: this.generateInvitationTextTemplate(inviterName, acceptUrl)
      };

      await sgMail.send(msg);
      logger.info(`Invitation sent from ${inviterName} to ${inviteeEmail}`);
    } catch (error) {
      logger.error('Error sending invitation:', error);
      throw error;
    }
  }

  /**
   * Send invite eligibility notification
   */
  async sendInviteEligibilityNotification(email, name, streakCount) {
    try {
      const msg = {
        to: email,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: 'You can now invite friends! 🎉',
        html: this.generateEligibilityTemplate(name, streakCount),
        text: `Hi ${name}!\n\nCongratulations! You've submitted recommendations for ${streakCount} consecutive weeks and can now invite friends to join our group.\n\nYou can invite up to 5 people total. Just reply to any weekly prompt email with "INVITE: friend@email.com" to send an invitation.\n\nThanks for being such a consistent contributor!\n\nBest,\nWeekly Recommendations Team`
      };

      await sgMail.send(msg);
      logger.info(`Eligibility notification sent to ${email}`);
    } catch (error) {
      logger.error('Error sending eligibility notification:', error);
    }
  }

  // HTML Templates

  generateWeeklyPromptTemplate(name, weekNumber, deadline) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Week ${weekNumber} Recommendations</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-size: 28px;">Week ${weekNumber} Recommendations</h1>
        <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">Time to share something great!</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="color: #495057; margin-top: 0;">Hey ${name}! 👋</h2>
        <p>It's time for this week's recommendations! Reply to this email with your submission using the format below:</p>
        
        <div style="background: white; padding: 20px; border-left: 4px solid #667eea; margin: 20px 0; border-radius: 4px;">
            <p style="margin: 0; font-weight: bold; color: #667eea;">RECOMMENDATION:</p>
            <p style="margin: 5px 0 15px 0; color: #666; font-style: italic;">[What you're recommending - book, movie, restaurant, app, etc.]</p>
            
            <p style="margin: 0; font-weight: bold; color: #667eea;">REASON WHY:</p>
            <p style="margin: 5px 0 15px 0; color: #666; font-style: italic;">[Why you recommend it - what makes it special?]</p>
            
            <p style="margin: 0; font-weight: bold; color: #667eea;">DIGRESSIONS:</p>
            <p style="margin: 5px 0 0 0; color: #666; font-style: italic;">[Life updates, thoughts, or silly messages to share with the group]</p>
        </div>
        
        <div style="background: #e7f3ff; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin: 0 0 10px 0; color: #0066cc;">Example:</h3>
            <p style="margin: 5px 0;"><strong>RECOMMENDATION:</strong> The Bear (TV show)</p>
            <p style="margin: 5px 0;"><strong>REASON WHY:</strong> Incredible acting and realistic kitchen chaos that's both stressful and hilarious</p>
            <p style="margin: 5px 0;"><strong>DIGRESSIONS:</strong> Doing pub trivia on Tuesday with some co-workers, let me know if you want to join!</p>
        </div>
    </div>
    
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin-bottom: 25px;">
        <p style="margin: 0; color: #856404;"><strong>⏰ Deadline: ${deadline}</strong></p>
        <p style="margin: 10px 0 0 0; color: #856404; font-size: 14px;">Submissions received after the deadline won't be included in this week's roundup.</p>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p>Happy sharing! 🎉</p>
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  generateWeeklyPromptTextTemplate(name, weekNumber, deadline) {
    return `Week ${weekNumber} Recommendations - Time to share something great!

Hey ${name}!

It's time for this week's recommendations! Reply to this email with your submission using this format:

RECOMMENDATION: [What you're recommending]
REASON WHY: [Why you recommend it]
DIGRESSIONS: [Life updates, thoughts, or silly messages to share with the group]

Example:
RECOMMENDATION: The Bear (TV show)
REASON WHY: Incredible acting and realistic kitchen chaos that's both stressful and hilarious
DIGRESSIONS: Doing pub trivia on Tuesday with some co-workers, let me know if you want to join!

Deadline: ${deadline}

Happy sharing!
Weekly Recommendations Team`;
  }

  generateCompilationTemplate(name, submissions, weekNumber) {
    const submissionsHtml = submissions.map(sub => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 15px; vertical-align: top;">
          <strong style="color: #667eea;">${sub.user.firstName || 'Friend'}</strong>
        </td>
        <td style="padding: 15px; vertical-align: top;">
          <strong>${sub.recommendation}</strong>
        </td>
        <td style="padding: 15px; vertical-align: top;">
          ${sub.reasons}
        </td>
        <td style="padding: 15px; vertical-align: top;">
          <em>${sub.message}</em>
        </td>
      </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Week ${weekNumber} Roundup</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-size: 28px;">Week ${weekNumber} Roundup</h1>
        <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">${submissions.length} amazing recommendations from the group!</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="color: #495057; margin-top: 0;">Hey ${name}! 🎉</h2>
        <p>Here are all the recommendations from this week's participants:</p>
    </div>
    
    <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr style="background: #667eea; color: white;">
                    <th style="padding: 15px; text-align: left; font-weight: bold;">Who</th>
                    <th style="padding: 15px; text-align: left; font-weight: bold;">Recommendation</th>
                    <th style="padding: 15px; text-align: left; font-weight: bold;">Reason Why</th>
                    <th style="padding: 15px; text-align: left; font-weight: bold;">Digressions</th>
                </tr>
            </thead>
            <tbody>
                ${submissionsHtml}
            </tbody>
        </table>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px; margin-top: 30px;">
        <p>Thanks to everyone who participated this week! 🙌</p>
        <p style="margin: 0;">See you next Thursday for Week ${weekNumber + 1}!</p>
    </div>
</body>
</html>`;
  }

  generateCompilationTextTemplate(submissions, weekNumber) {
    const submissionsText = submissions.map(sub => 
      `${sub.user.firstName || 'Friend'}: ${sub.recommendation}\n` +
      `Reason Why: ${sub.reasons}\n` +
      `Digressions: ${sub.message}\n`
    ).join('\n---\n\n');

    return `Week ${weekNumber} Recommendations Roundup

${submissions.length} amazing recommendations from the group!

${submissionsText}

Thanks to everyone who participated this week!
See you next Thursday for Week ${weekNumber + 1}!

Weekly Recommendations Team`;
  }

  generateConfirmationTemplate(name, submissionData, weekNumber) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submission Confirmed</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="margin: 0 0 10px 0;">✅ Submission Confirmed!</h2>
        <p style="margin: 0;">Your Week ${weekNumber} recommendation has been received.</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h3 style="margin-top: 0; color: #495057;">Your submission:</h3>
        <p><strong>Recommendation:</strong> ${submissionData.recommendation}</p>
        <p><strong>Reason Why:</strong> ${submissionData.reasonWhy}</p>
        <p><strong>Digressions:</strong> ${submissionData.digressions}</p>
    </div>
    
    <p>Thanks ${name}! You'll receive the full roundup after the submission deadline with everyone's recommendations.</p>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  generateConfirmationTextTemplate(name, submissionData, weekNumber) {
    return `Submission Confirmed!

Hi ${name}!

Your Week ${weekNumber} recommendation has been received:

Recommendation: ${submissionData.recommendation}
Reason Why: ${submissionData.reasonWhy}
Digressions: ${submissionData.digressions}

You'll receive the full roundup after the submission deadline with everyone's recommendations.

Thanks!
Weekly Recommendations Team`;
  }

  generateErrorTemplate(errorType, message) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submission Issue</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="margin: 0 0 10px 0;">⚠️ ${errorType}</h2>
        <p style="margin: 0;">${message}</p>
    </div>
    
    <p>If you need help with your submission, please reply to this email and we'll assist you.</p>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  generateFormatErrorTemplate(errorMessages) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submission Format Error</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="margin: 0 0 10px 0;">📝 Submission Format Issue</h2>
        <p style="margin: 0;">There was a problem with your submission format: ${errorMessages}</p>
    </div>
    
    <div style="background: #e7f3ff; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h3 style="margin-top: 0; color: #0066cc;">Please use this exact format:</h3>
        <p style="margin: 5px 0;"><strong>RECOMMENDATION:</strong> [What you're recommending]</p>
        <p style="margin: 5px 0;"><strong>REASON WHY:</strong> [Why you recommend it]</p>
        <p style="margin: 5px 0;"><strong>DIGRESSIONS:</strong> [Life updates, thoughts, or silly messages]</p>
    </div>
    
    <p>Please reply with your corrected submission. If you need help, just reply to this email!</p>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  generateFormatErrorTextTemplate(errorMessages) {
    return `Submission Format Issue

There was a problem with your submission format: ${errorMessages}

Please use this exact format:

RECOMMENDATION: [What you're recommending]
REASON WHY: [Why you recommend it]
DIGRESSIONS: [Life updates, thoughts, or silly messages]

Please reply with your corrected submission. If you need help, just reply to this email!

Weekly Recommendations Team`;
  }

  generateInvitationTemplate(inviterName, acceptUrl) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>You're Invited!</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-size: 28px;">You're Invited! 🎉</h1>
        <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">Join our Weekly Recommendations group</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <p style="font-size: 18px; margin-top: 0;">Hi there!</p>
        <p><strong>${inviterName}</strong> has invited you to join our Weekly Recommendations group!</p>
        
        <p>Every week, we share one thing we recommend - could be a book, movie, restaurant, app, podcast, or anything else worth sharing. It's a fun way to discover new things and stay connected.</p>
        
        <div style="text-align: center; margin: 30px 0;">
            <a href="${acceptUrl}" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Accept Invitation</a>
        </div>
        
        <p style="font-size: 14px; color: #666;">This invitation will expire in 7 days.</p>
    </div>
    
    <div style="background: #e7f3ff; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h3 style="margin-top: 0; color: #0066cc;">How it works:</h3>
        <ul style="margin: 0; padding-left: 20px;">
            <li>Every Thursday, you'll get an email prompt</li>
            <li>Reply with your recommendation, reason why, and digressions</li>
            <li>Sunday evening, everyone gets a roundup with all recommendations</li>
            <li>After 4 weeks of participation, you can invite friends too!</li>
        </ul>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }

  generateInvitationTextTemplate(inviterName, acceptUrl) {
    return `You're Invited to Weekly Recommendations!

Hi there!

${inviterName} has invited you to join our Weekly Recommendations group!

Every week, we share one thing we recommend - could be a book, movie, restaurant, app, podcast, or anything else worth sharing. It's a fun way to discover new things and stay connected.

How it works:
- Every Thursday, you'll get an email prompt
- Reply with your recommendation, reason why, and digressions  
- Sunday evening, everyone gets a roundup with all recommendations
- After 4 weeks of participation, you can invite friends too!

Accept your invitation here: ${acceptUrl}

This invitation will expire in 7 days.

Weekly Recommendations Team`;
  }

  generateEligibilityTemplate(name, streakCount) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>You can now invite friends!</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <h1 style="margin: 0; font-size: 28px;">🎉 Congratulations!</h1>
        <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">You can now invite friends!</p>
    </div>
    
    <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
        <h2 style="color: #495057; margin-top: 0;">Amazing work, ${name}!</h2>
        <p>You've submitted recommendations for <strong>${streakCount} consecutive weeks</strong> and have unlocked the ability to invite friends to our group! 🎊</p>
        
        <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="margin: 0; color: #155724;"><strong>You can invite up to 5 people total.</strong></p>
        </div>
        
        <h3 style="color: #495057;">How to invite someone:</h3>
        <p>Reply to any weekly prompt email with:</p>
        <div style="background: white; padding: 15px; border-left: 4px solid #28a745; margin: 15px 0; border-radius: 4px;">
            <p style="margin: 0; font-family: monospace;"><strong>INVITE: friend@email.com</strong></p>
        </div>
        
        <p style="font-size: 14px; color: #666;">Thanks for being such a consistent contributor to our group!</p>
    </div>
    
    <div style="text-align: center; color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0;">Weekly Recommendations Team</p>
    </div>
</body>
</html>`;
  }
}

module.exports = { EmailService };