const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { WeeklyAutomation } = require('../services/weeklyAutomation');
const { InvitationService } = require('../services/invitationService');
const logger = require('../utils/logger');
const moment = require('moment-timezone');

const router = express.Router();
const prisma = new PrismaClient();

// Initialize services
const weeklyAutomation = new WeeklyAutomation();
const invitationService = new InvitationService();

/**
 * Simple auth middleware (basic protection for admin routes)
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const adminKey = process.env.ADMIN_KEY;

  if (!adminKey) {
    return res.status(501).json({ error: 'Admin functionality not configured' });
  }

  if (!authHeader || authHeader !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * Get system overview/dashboard
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Get current week status
    const currentWeekStatus = await weeklyAutomation.getCurrentWeekStatus();
    
    // Get user statistics
    const userStats = await prisma.user.aggregate({
      _count: { id: true },
      where: { isActive: true }
    });

    const inactiveUsers = await prisma.user.count({
      where: { isActive: false }
    });

    // Get submission statistics
    const submissionStats = await prisma.submission.groupBy({
      by: ['weekId'],
      _count: { id: true },
      orderBy: { weekId: 'desc' },
      take: 10
    });

    // Get invitation statistics
    const inviteStats = await invitationService.getInvitationStats();

    // Get recent weeks
    const recentWeeks = await prisma.week.findMany({
      take: 5,
      orderBy: { weekNumber: 'desc' },
      include: {
        submissions: {
          include: {
            user: {
              select: { firstName: true, lastName: true, email: true }
            }
          }
        }
      }
    });

    // Get users with longest streaks
    const topStreaks = await prisma.userStreak.findMany({
      take: 10,
      orderBy: { currentStreak: 'desc' },
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true }
        }
      }
    });

    return res.json({
      timestamp: new Date().toISOString(),
      currentWeek: currentWeekStatus,
      users: {
        active: userStats._count.id,
        inactive: inactiveUsers,
        total: userStats._count.id + inactiveUsers
      },
      invitations: inviteStats,
      recentWeeks: recentWeeks.map(week => ({
        weekNumber: week.weekNumber,
        status: week.status,
        submissionCount: week.submissions.length,
        deadline: week.deadline,
        participants: week.submissions.map(s => 
          s.user.firstName ? `${s.user.firstName} ${s.user.lastName || ''}`.trim() : s.user.email
        )
      })),
      topStreaks: topStreaks.map(streak => ({
        user: streak.user.firstName ? 
          `${streak.user.firstName} ${streak.user.lastName || ''}`.trim() : 
          streak.user.email,
        currentStreak: streak.currentStreak,
        longestStreak: streak.longestStreak,
        canInvite: streak.canInvite
      }))
    });

  } catch (error) {
    logger.error('Error getting dashboard data:', error);
    return res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

/**
 * Get all weeks
 */
router.get('/weeks', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = status ? { status } : {};

    const weeks = await prisma.week.findMany({
      where,
      orderBy: { weekNumber: 'desc' },
      skip: offset,
      take: parseInt(limit),
      include: {
        submissions: {
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, email: true }
            }
          }
        }
      }
    });

    const total = await prisma.week.count({ where });

    return res.json({
      weeks,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    logger.error('Error getting weeks:', error);
    return res.status(500).json({ error: 'Failed to get weeks' });
  }
});

/**
 * Get all users
 */
router.get('/users', requireAuth, async (req, res) => {
  try {
    const { active, search } = req.query;
    
    const where = {};
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } }
      ];
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { joinDate: 'desc' },
      include: {
        streak: true,
        sentInvites: {
          select: { status: true, inviteeEmail: true, sentAt: true }
        },
        submissions: {
          select: { weekId: true, submittedAt: true },
          orderBy: { submittedAt: 'desc' },
          take: 5
        }
      }
    });

    return res.json({
      users: users.map(user => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        joinDate: user.joinDate,
        isActive: user.isActive,
        inviteCount: user.inviteCount,
        streak: user.streak,
        recentSubmissions: user.submissions,
        sentInvites: user.sentInvites
      }))
    });

  } catch (error) {
    logger.error('Error getting users:', error);
    return res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * Start new week manually
 */
router.post('/weeks/start', requireAuth, async (req, res) => {
  try {
    const result = await weeklyAutomation.manualStartWeek();
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Manual week start completed:', result);
    return res.json(result);

  } catch (error) {
    logger.error('Error starting week manually:', error);
    return res.status(500).json({ error: 'Failed to start week' });
  }
});

/**
 * Compile week manually
 */
router.post('/weeks/:id/compile', requireAuth, async (req, res) => {
  try {
    const weekId = parseInt(req.params.id);
    const result = await weeklyAutomation.manualCompileWeek(weekId);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Manual compilation completed:', result);
    return res.json(result);

  } catch (error) {
    logger.error('Error compiling week manually:', error);
    return res.status(500).json({ error: 'Failed to compile week' });
  }
});

/**
 * Send reminder emails
 */
router.post('/weeks/remind', requireAuth, async (req, res) => {
  try {
    const result = await weeklyAutomation.sendReminders();
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Reminders sent:', result);
    return res.json(result);

  } catch (error) {
    logger.error('Error sending reminders:', error);
    return res.status(500).json({ error: 'Failed to send reminders' });
  }
});

/**
 * Update user status
 */
router.patch('/users/:id', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { isActive, firstName, lastName } = req.body;

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      include: { streak: true }
    });

    logger.info('User updated:', { userId, updateData });
    return res.json({ success: true, user });

  } catch (error) {
    logger.error('Error updating user:', error);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * Delete user (soft delete by making inactive)
 */
router.delete('/users/:id', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isActive: false }
    });

    logger.info('User deactivated:', { userId });
    return res.json({ success: true, message: 'User deactivated' });

  } catch (error) {
    logger.error('Error deactivating user:', error);
    return res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

/**
 * Get system logs (limited)
 */
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const { level = 'info', limit = 100 } = req.query;
    
    // This would need to be implemented based on your logging setup
    // For now, just return a placeholder
    return res.json({
      message: 'Log viewing not implemented',
      suggestion: 'Check your application logs directly or implement log storage'
    });

  } catch (error) {
    logger.error('Error getting logs:', error);
    return res.status(500).json({ error: 'Failed to get logs' });
  }
});

/**
 * Run cleanup tasks
 */
router.post('/cleanup', requireAuth, async (req, res) => {
  try {
    const { weeks, invites } = req.query;

    const results = {};

    if (weeks !== 'false') {
      const weeksToKeep = weeks ? parseInt(weeks) : 12;
      results.weekCleanup = await weeklyAutomation.cleanupOldData(weeksToKeep);
    }

    if (invites !== 'false') {
      results.inviteCleanup = await invitationService.cleanupExpiredInvites();
    }

    logger.info('Cleanup completed:', results);
    return res.json({ success: true, results });

  } catch (error) {
    logger.error('Error running cleanup:', error);
    return res.status(500).json({ error: 'Cleanup failed' });
  }
});

/**
 * Health check for admin routes
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'admin',
    timestamp: new Date().toISOString(),
    hasAuth: !!process.env.ADMIN_KEY
  });
});

module.exports = router;