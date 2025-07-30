const winston = require('winston');

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { 
    service: 'weekly-recommendations',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// If we're not in production, log to the console with a simple format
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level}]: ${message}`;
        
        // Add metadata if it exists
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        
        return log;
      })
    )
  }));
}

// Create logs directory if it doesn't exist
const fs = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Add method to log email events specifically
logger.emailEvent = (event, data = {}) => {
  logger.info('Email Event', {
    event,
    ...data,
    category: 'email'
  });
};

// Add method to log user actions
logger.userAction = (action, userId, data = {}) => {
  logger.info('User Action', {
    action,
    userId,
    ...data,
    category: 'user'
  });
};

// Add method to log system events
logger.systemEvent = (event, data = {}) => {
  logger.info('System Event', {
    event,
    ...data,
    category: 'system'
  });
};

// Add method to log webhook events
logger.webhookEvent = (event, data = {}) => {
  logger.info('Webhook Event', {
    event,
    ...data,
    category: 'webhook'
  });
};

// Add method to log cron job events
logger.cronEvent = (job, status, data = {}) => {
  logger.info('Cron Job', {
    job,
    status,
    ...data,
    category: 'cron'
  });
};

// Error handling for the logger itself
logger.on('error', (error) => {
  console.error('Logger error:', error);
});

module.exports = logger;