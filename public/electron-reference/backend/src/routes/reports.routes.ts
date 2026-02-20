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
            { $sort: { start_time: 1 } },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: "%Y-%m-%d", date: "$start_time" } },
                        user: "$user_id"
                    },
                    inTime: { $first: "$start_time" },
                    finishTime: { $last: "$end_time" },
                    activeDuration: { $sum: "$summary.active_duration" },
                    idleDuration: { $sum: "$summary.idle_duration" },
                    sessions: { $push: "$$ROOT" }
                }
            },
            { $sort: { "_id.date": -1 } }
        ]);

        const formatDuration = (seconds: number) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };

        const populated = await Promise.all(sessions.map(async (record) => {
            // DETAILED VIEW LOGIC
            let timeline: any[] = [];
            if (req.query.detailed === 'true') {
                timeline = record.sessions.flatMap((s: any) => {
                    const segments = [];
                    // Simple segment connection from events
                    // This is a simplified version. Ideally, process events in order.
                    // For now, let's just show basic start/end of session as "Work"
                    // and any "idle_start" to "idle_end" as "Offline" (or Idle)

                    // Better approach: iterate events
                    let lastTime = new Date(s.start_time).getTime();
                    let state = 'Work';

                    if (s.events && s.events.length > 0) {
                        s.events.forEach((e: any) => {
                            const time = new Date(e.timestamp).getTime();
                            const duration = Math.floor((time - lastTime) / 1000);

                            if (duration > 0) {
                                segments.push({
                                    start: new Date(lastTime).toISOString(),
                                    end: new Date(time).toISOString(),
                                    type: state,
                                    duration: formatDuration(duration)
                                });
                            }

                            if (e.type === 'pause' || e.type === 'idle_start') state = 'Offline';
                            else if (e.type === 'resume' || e.type === 'idle_end' || e.type === 'start') state = 'Work';

                            lastTime = time;
                        });
                    }

                    // Add final segment if Active
                    if (s.status === 'active') {
                        const now = Date.now();
                        const duration = Math.floor((now - lastTime) / 1000);
                        if (duration > 0) {
                            segments.push({
                                start: new Date(lastTime).toISOString(),
                                end: new Date(now).toISOString(),
                                type: state,
                                duration: formatDuration(duration)
                            });
                        }
                    } else if (s.end_time) {
                        // Session ended
                        // check if we covered up to end_time
                        const endT = new Date(s.end_time).getTime();
                        if (endT > lastTime) {
                            const dur = Math.floor((endT - lastTime) / 1000);
                            segments.push({
                                start: new Date(lastTime).toISOString(),
                                end: new Date(endT).toISOString(),
                                type: state,
                                duration: formatDuration(dur)
                            });
                        }
                    }

                    return segments;
                });
            }

            const hourlyData: Record<string, string> = {};
            const hoursToCheck = ["7 AM", "8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM", "9 PM", "10 PM", "11 PM"];

            hoursToCheck.forEach(h => {
                let hour = parseInt(h.split(' ')[0]);
                if (h.includes('PM') && hour !== 12) hour += 12;
                if (h.includes('AM') && hour === 12) hour = 0;

                const hasSession = record.sessions.some((s: any) => {
                    const paramsStart = new Date(s.start_time);
                    const paramsEnd = s.end_time ? new Date(s.end_time) : new Date();
                    return paramsStart.getHours() <= hour && paramsEnd.getHours() >= hour;
                });

                if (hasSession) hourlyData[h] = "Active";
            });

            return {
                date: record._id.date,
                inTime: record.inTime,
                finishTime: record.finishTime,
                workHours: formatDuration(record.activeDuration),
                idleHours: formatDuration(record.idleDuration),
                hourlyData,
                user_id: record._id.user,
                timeline // Return detailed timeline if requested
            };
        }));

        res.json({ success: true, data: populated });

    } catch (err) {
        next(err);
    }
});

export const reportRoutes = router;
