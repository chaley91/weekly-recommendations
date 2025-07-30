require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const moment = require('moment-timezone');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  try {
    // Create sample users
    const users = await Promise.all([
      prisma.user.upsert({
        where: { email: 'alice@example.com' },
        update: {},
        create: {
          email: 'alice@example.com',
          firstName: 'Alice',
          lastName: 'Johnson',
          isActive: true,
          joinDate: moment().subtract(8, 'weeks').toDate()
        }
      }),
      prisma.user.upsert({
        where: { email: 'bob@example.com' },
        update: {},
        create: {
          email: 'bob@example.com',
          firstName: 'Bob',
          lastName: 'Smith',
          isActive: true,
          joinDate: moment().subtract(6, 'weeks').toDate()
        }
      }),
      prisma.user.upsert({
        where: { email: 'carol@example.com' },
        update: {},
        create: {
          email: 'carol@example.com',
          firstName: 'Carol',
          lastName: 'Davis',
          isActive: true,
          joinDate: moment().subtract(4, 'weeks').toDate()
        }
      }),
      prisma.user.upsert({
        where: { email: 'david@example.com' },
        update: {},
        create: {
          email: 'david@example.com',
          firstName: 'David',
          lastName: 'Wilson',
          isActive: true,
          joinDate: moment().subtract(2, 'weeks').toDate()
        }
      })
    ]);

    console.log('✅ Created users:', users.map(u => u.email));

    // Create user streaks
    const streaks = await Promise.all([
      prisma.userStreak.upsert({
        where: { userId: users[0].id },
        update: {},
        create: {
          userId: users[0].id,
          currentStreak: 6,
          longestStreak: 8,
          lastSubmissionWeek: moment().week() + moment().year() * 100 - 1,
          canInvite: true,
          inviteEligibleSince: moment().subtract(4, 'weeks').toDate()
        }
      }),
      prisma.userStreak.upsert({
        where: { userId: users[1].id },
        update: {},
        create: {
          userId: users[1].id,
          currentStreak: 4,
          longestStreak: 5,
          lastSubmissionWeek: moment().week() + moment().year() * 100 - 1,
          canInvite: true,
          inviteEligibleSince: moment().subtract(2, 'weeks').toDate()
        }
      }),
      prisma.userStreak.upsert({
        where: { userId: users[2].id },
        update: {},
        create: {
          userId: users[2].id,
          currentStreak: 3,
          longestStreak: 3,
          lastSubmissionWeek: moment().week() + moment().year() * 100 - 1,
          canInvite: false
        }
      }),
      prisma.userStreak.upsert({
        where: { userId: users[3].id },
        update: {},
        create: {
          userId: users[3].id,
          currentStreak: 1,
          longestStreak: 2,
          lastSubmissionWeek: moment().week() + moment().year() * 100 - 1,
          canInvite: false
        }
      })
    ]);

    console.log('✅ Created user streaks');

    // Create sample weeks
    const weeks = [];
    for (let i = 4; i >= 0; i--) {
      const weekStart = moment().subtract(i, 'weeks').day(4).startOf('day'); // Thursday
      const weekNumber = weekStart.week() + weekStart.year() * 100;
      const deadline = weekStart.clone().day(7).hour(18).minute(0); // Sunday 6 PM
      
      const status = i === 0 ? 'open' : 'compiled';
      
      const week = await prisma.week.upsert({
        where: { weekNumber },
        update: {},
        create: {
          weekNumber,
          startDate: weekStart.toDate(),
          deadline: deadline.toDate(),
          status
        }
      });
      
      weeks.push(week);
    }

    console.log('✅ Created weeks:', weeks.map(w => w.weekNumber));

    // Create sample submissions for past weeks
    const submissions = [];
    for (let weekIndex = 0; weekIndex < weeks.length - 1; weekIndex++) { // Skip current week
      const week = weeks[weekIndex];
      
      // Alice submits every week
      if (weekIndex < 4) {
        submissions.push(await prisma.submission.upsert({
          where: {
            userId_weekId: {
              userId: users[0].id,
              weekId: week.id
            }
          },
          update: {},
          create: {
            userId: users[0].id,
            weekId: week.id,
            recommendation: `Book: "The Midnight Library" by Matt Haig`,
            reasons: "A beautiful exploration of life's infinite possibilities and the power of small choices. Really made me think about regret and gratitude.",
            message: "Been reading this during my commute and almost missed my stop twice because I was so absorbed. Anyone else have books that make you lose track of time?"
          }
        }));
      }

      // Bob submits most weeks
      if (weekIndex < 3 && weekIndex !== 1) {
        submissions.push(await prisma.submission.upsert({
          where: {
            userId_weekId: {
              userId: users[1].id,
              weekId: week.id
            }
          },
          update: {},
          create: {
            userId: users[1].id,
            weekId: week.id,
            recommendation: `Podcast: "Conan O'Brien Needs a Friend"`,
            reasons: "Hilarious conversations with celebrities and just regular people. Conan's wit and genuine curiosity make every episode entertaining.",
            message: "Started listening during my daily walks and now I actually look forward to doing errands. My neighbors probably think I'm weird for laughing out loud while walking the dog 🐕"
          }
        }));
      }

      // Carol submits recent weeks
      if (weekIndex < 2) {
        submissions.push(await prisma.submission.upsert({
          where: {
            userId_weekId: {
              userId: users[2].id,
              weekId: week.id
            }
          },
          update: {},
          create: {
            userId: users[2].id,
            weekId: week.id,
            recommendation: `App: Duolingo`,
            reasons: "Finally got back into learning Spanish after years. The gamification really works to keep you motivated daily.",
            message: "My 127-day streak is becoming an unhealthy obsession but ¡estoy aprendiendo mucho! Anyone want to be Duolingo friends and keep each other accountable?"
          }
        }));
      }

      // David submits last week only
      if (weekIndex === 0) {
        submissions.push(await prisma.submission.upsert({
          where: {
            userId_weekId: {
              userId: users[3].id,
              weekId: week.id
            }
          },
          update: {},
          create: {
            userId: users[3].id,
            weekId: week.id,
            recommendation: `Restaurant: Joe's Pizza (NYC)`,
            reasons: "Classic New York slice that hasn't changed in decades. Perfect cheese-to-sauce ratio and that crispy-chewy crust.",
            message: "Went here after a terrible date last week and honestly the pizza was the best part of the evening. Sometimes you just need a reliable slice to restore your faith in simple pleasures 🍕"
          }
        }));
      }
    }

    console.log('✅ Created submissions:', submissions.length);

    // Create sample invitations
    const sampleInvites = await Promise.all([
      prisma.invite.upsert({
        where: { inviteToken: 'sample-token-1' },
        update: {},
        create: {
          inviterId: users[0].id,
          inviteeEmail: 'emily@example.com',
          inviteToken: 'sample-token-1',
          status: 'pending',
          expiresAt: moment().add(5, 'days').toDate()
        }
      }),
      prisma.invite.upsert({
        where: { inviteToken: 'sample-token-2' },
        update: {},
        create: {
          inviterId: users[1].id,
          inviteeEmail: 'frank@example.com',
          inviteToken: 'sample-token-2',
          status: 'accepted',
          acceptedAt: moment().subtract(1, 'week').toDate(),
          expiresAt: moment().subtract(1, 'day').toDate()
        }
      })
    ]);

    console.log('✅ Created sample invitations');

    // Update invite counts
    await prisma.user.update({
      where: { id: users[0].id },
      data: { inviteCount: 1 }
    });

    await prisma.user.update({
      where: { id: users[1].id },
      data: { inviteCount: 1 }
    });

    // Create some system settings
    await prisma.systemSettings.upsert({
      where: { key: 'last_cleanup' },
      update: { value: new Date().toISOString() },
      create: {
        key: 'last_cleanup',
        value: new Date().toISOString()
      }
    });

    await prisma.systemSettings.upsert({
      where: { key: 'total_emails_sent' },
      update: { value: '156' },
      create: {
        key: 'total_emails_sent',
        value: '156'
      }
    });

    console.log('✅ Created system settings');

    // Summary
    const totalUsers = await prisma.user.count();
    const totalWeeks = await prisma.week.count();
    const totalSubmissions = await prisma.submission.count();
    const totalInvites = await prisma.invite.count();

    console.log('\n📊 Seed Summary:');
    console.log(`   Users: ${totalUsers}`);
    console.log(`   Weeks: ${totalWeeks}`);
    console.log(`   Submissions: ${totalSubmissions}`);
    console.log(`   Invitations: ${totalInvites}`);
    console.log('\n🎉 Database seeded successfully!');

    // Display current week info
    const currentWeek = weeks[weeks.length - 1];
    console.log(`\n📅 Current active week: ${currentWeek.weekNumber}`);
    console.log(`   Deadline: ${moment(currentWeek.deadline).format('dddd, MMMM Do [at] h:mm A')}`);
    console.log(`   Status: ${currentWeek.status}`);

    // Display user eligibility
    console.log('\n👥 User Status:');
    for (const user of users) {
      const streak = streaks.find(s => s.userId === user.id);
      console.log(`   ${user.firstName}: ${streak.currentStreak} week streak, ${streak.canInvite ? 'CAN' : 'CANNOT'} invite`);
    }

    console.log('\n💡 Next Steps:');
    console.log('   1. Deploy to Railway');
    console.log('   2. Configure SendGrid with your domain (weeklyrecs.com)');
    console.log('   3. Add yourself as a user in the database');
    console.log('   4. Test by sending email to submit@weeklyrecs.com');
    console.log('\n📧 Sample Email Format:');
    console.log('   RECOMMENDATION: The Bear (TV show)');
    console.log('   REASON WHY: Amazing acting and kitchen chaos');
    console.log('   DIGRESSIONS: Doing pub trivia on Tuesday, let me know if you want to join!');

  } catch (error) {
    console.error('❌ Error during seed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});