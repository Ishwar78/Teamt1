import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roleGuard';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { ActivityLog } from '../models/ActivityLog';
import { Types } from 'mongoose';

const router = Router();

// GET /summary - Overall company stats
router.get('/summary', authenticate, requireRole('company_admin', 'sub_admin'), async (req: any, res, next) => {
    try {
        const companyId = new Types.ObjectId(req.auth.company_id as string);

        // Aggregation for totals
        const totalStats = await Session.aggregate([
            { $match: { company_id: companyId } },
            {
                $group: {
                    _id: null,
                    totalActive: { $sum: "$summary.active_duration" },
                    totalIdle: { $sum: "$summary.idle_duration" },
                    totalDuration: { $sum: "$summary.total_duration" },
                    totalScreenshots: { $sum: "$summary.screenshots_count" },
                    avgScore: { $avg: "$summary.activity_score" }
                }
            }
        ]);

        const stats = totalStats[0] || { totalActive: 0, totalIdle: 0, totalDuration: 0, totalScreenshots: 0, avgScore: 0 };

        // Weekly data (last 7 days active hours)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const weeklyStats = await Session.aggregate([
            {
                $match: {
                    company_id: companyId,
                    start_time: { $gte: sevenDaysAgo }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$start_time" } },
                    hours: { $sum: "$summary.active_duration" }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Format weekly data
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const formattedWeekly = weeklyStats.map(d => {
            const date = new Date(d._id);
            return {
                day: days[date.getDay()],
                hours: Math.round((d.hours / 3600) * 10) / 10 // seconds to hours
            };
        });

        res.json({
            success: true,
            totals: {
                active: Math.round((stats.totalActive / 3600) * 10) / 10,
                idle: Math.round((stats.totalIdle / 3600) * 10) / 10,
                total: Math.round((stats.totalDuration / 3600) * 10) / 10,
                screenshots: stats.totalScreenshots,
                avgProd: Math.round(stats.avgScore || 0)
            },
            weekly: formattedWeekly
        });

    } catch (err) {
        next(err);
    }
});

// GET /users - Per user stats
router.get('/users', authenticate, requireRole('company_admin', 'sub_admin'), async (req: any, res, next) => {
    try {
        const companyId = new Types.ObjectId(req.auth.company_id as string);

        const userStats = await Session.aggregate([
            { $match: { company_id: companyId } },
            {
                $group: {
                    _id: "$user_id",
                    active: { $sum: "$summary.active_duration" },
                    idle: { $sum: "$summary.idle_duration" },
                    total: { $sum: "$summary.total_duration" },
                    screenshots: { $sum: "$summary.screenshots_count" },
                    avgScore: { $avg: "$summary.activity_score" }
                }
            }
        ]);

        // Populate user details and top app
        const populatedStats = await Promise.all(userStats.map(async (stat) => {
            const user = await User.findById(stat._id).select('name role').lean();

            // Get top app from ActivityLog
            const topApp = await ActivityLog.aggregate([
                { $match: { user_id: stat._id, company_id: companyId } },
                { $group: { _id: "$active_window.app_name", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 1 }
            ]);

            return {
                id: stat._id,
                name: user?.name || 'Unknown',
                role: user?.role || 'User',
                activeH: Math.round((stat.active / 3600) * 10) / 10,
                idleH: Math.round((stat.idle / 3600) * 10) / 10,
                totalH: Math.round((stat.total / 3600) * 10) / 10,
                screenshots: stat.screenshots,
                productivity: Math.round(stat.avgScore || 0),
                topApp: topApp[0]?._id || 'N/A'
            };
        }));

        res.json({ success: true, users: populatedStats });

    } catch (err) {
        next(err);
    }
});

// GET /attendance - Detailed attendance sheet
router.get('/attendance', authenticate, async (req: any, res, next) => {
    try {
        const companyId = new Types.ObjectId(req.auth.company_id as string);
        const { userId, startDate, endDate } = req.query;

        const query: any = {
            company_id: companyId,
            start_time: {
                $gte: new Date(startDate as string),
                $lte: new Date(endDate as string)
            }
        };

        if (userId) {
            query.user_id = new Types.ObjectId(userId as string);
        } else if (req.auth.role === 'employee') {
            // Employees can only see their own attendance
            query.user_id = new Types.ObjectId(req.auth.user_id as string);
        }

        const sessions = await Session.aggregate([
            { $match: query },
            { $sort: { start_time: 1 } }, // Sort by time to get correct in/out
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: "%Y-%m-%d", date: "$start_time" } },
                        user: "$user_id"
                    },
                    inTime: { $first: "$start_time" },
                    finishTime: { $last: "$end_time" }, // Might be null if active
                    activeDuration: { $sum: "$summary.active_duration" },
                    idleDuration: { $sum: "$summary.idle_duration" },
                    sessions: { $push: "$$ROOT" } // Keep sessions for hourly breakdown if needed
                }
            },
            { $sort: { "_id.date": -1 } }
        ]);

        // Helper to format seconds to HH:MM:SS
        const formatDuration = (seconds: number) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        // Populate user names if needed (for admin view)
        const populated = await Promise.all(sessions.map(async (record) => {
            // Calculate hourly status (Simplified for now: if session exists in hour, mark Active)
            const hourlyData: Record<string, string> = {};
            const hoursToCheck = ["7 AM", "8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM", "9 PM", "10 PM", "11 PM"];

            // Default all to absent/empty
            // In a real implementation, we'd check overlapping time ranges. 
            // For now, let's mark the hours between inTime and finishTime as "Active" or check session overlaps.

            // Simple logic: If we have a session covering this hour.
            // Using a simple check against session start/end times.

            hoursToCheck.forEach(h => {
                // Parse hour string to 0-23
                let hour = parseInt(h.split(' ')[0]);
                if (h.includes('PM') && hour !== 12) hour += 12;
                if (h.includes('AM') && hour === 12) hour = 0;

                const hasSession = record.sessions.some((s: any) => {
                    const paramsStart = new Date(s.start_time);
                    const paramsEnd = s.end_time ? new Date(s.end_time) : new Date(); // If active, assume until now
                    return paramsStart.getHours() <= hour && paramsEnd.getHours() >= hour;
                });

                if (hasSession) hourlyData[h] = "Active";
                // else hourlyData[h] = "Absent"; // Or leave undefined/empty
            });

            return {
                date: record._id.date, // YYYY-MM-DD
                inTime: record.inTime,
                finishTime: record.finishTime,
                workHours: formatDuration(record.activeDuration),
                idleHours: formatDuration(record.idleDuration),
                hourlyData,
                user_id: record._id.user
            };
        }));

        res.json({ success: true, data: populated });

    } catch (err) {
        next(err);
    }
});

export const reportRoutes = router;
