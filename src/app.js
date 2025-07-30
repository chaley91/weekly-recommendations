require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

// Services
const { WeeklyAutomation } = require('./services/weeklyAutomation');
const { InvitationService } = require('./services/invitationService');
const logger = require('./utils/logger');

// Routes
const webhookRoutes = require('./routes/webhooks');
const inviteRoutes = require('./routes/invites');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
const weeklyAutomation = new WeeklyAutomation();
const invitationService = new InvitationService();

// Middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Body parsing middleware
app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/invite', inviteRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Weekly Recommendations System',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      webhook: '/webhook/inbound-email',
      invite: '/api/invite'
    }
  });
});

// Cron Jobs
function initializeCronJobs() {
  // Every Thursday at 9 AM - Start new week
  cron.schedule('0 9 * * 4', async () => {
    try {
      logger.info('Starting new week cron job');
      await weeklyAutomation.startNewWeek();
      logger.info('New week started successfully');
    } catch (error) {
      logger.error('Error starting new week:', error);
    }
  }, {
    timezone: process.env.TIMEZONE || 'America/New_York'
  });

  // Every Sunday at 6 PM - Close submissions and compile
  cron.schedule('0 18 * * 0', async () => {
    try {
      logger.info('Starting weekly compilation cron job');
      await weeklyAutomation.closeWeekAndCompile();
      logger.info('Weekly compilation completed successfully');
    } catch (error) {
      logger.error('Error compiling weekly submissions:', error);
    }
  }, {
    timezone: process.env.TIMEZONE || 'America/New_York'
  });

  // Daily at 10 AM - Check for invite eligibility updates
  cron.schedule('0 10 * * *', async () => {
    try {
      logger.info('Checking invite eligibility for all users');
      await invitationService.checkAllUsersEligibility();
      logger.info('Invite eligibility check completed');
    } catch (error) {
      logger.error('Error checking invite eligibility:', error);
    }
  }, {
    timezone: process.env.TIMEZONE || 'America/New_York'
  });

  logger.info('Cron jobs initialized');
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'The requested resource was not found'
  });
});

// Start server
async function startServer() {
  try {
    // Initialize cron jobs
    initializeCronJobs();
    
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
      logger.info(`Timezone: ${process.env.TIMEZONE || 'America/New_York'}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

startServer();

module.exports = app;