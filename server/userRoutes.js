const express = require("express");
const QRCode = require('qrcode');
const pool = require("./db/db");
const canvasApi = require('./canvasApi');

const { verifyToken, authorizeRoles } = require("./authMiddleware");

const router = express.Router();


router.get("/classrooms", verifyToken, authorizeRoles("professor"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM classrooms WHERE professor_id = $1",
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch classrooms" });
  }
});

//Not exactly sure if this is correct, may delete for a new one later just for students.
router.get(
  "/classrooms/:id/upcoming-sessions",
  verifyToken,
  authorizeRoles("student", "professor"),
  async (req, res) => {
    const { id } = req.params;

    try {
      // Query classroom schedule + time block
      const classroomQuery = `
        SELECT 
          c.days_of_week, 
          c.start_date, 
          c.end_date, 
          tb.start_time, 
          tb.end_time
        FROM classrooms c
        JOIN time_blocks tb ON c.time_block_id = tb.id
        WHERE c.id = $1
      `;

      const { rows } = await pool.query(classroomQuery, [id]);

      if (rows.length === 0) {
        return res.status(404).json({ error: "Classroom not found" });
      }

      const { days_of_week, start_date, end_date, start_time, end_time } = rows[0];

      const classDayMap = { S: 0, M: 1, T: 2, W: 3, R: 4, F: 5, U: 6 };
      const dayNums = days_of_week.map((d) => classDayMap[d]);

      const start = new Date(start_date);
      const end = new Date(end_date);
      const today = new Date();

      const sessions = [];

      for (
        let d = new Date(Math.max(today.getTime(), start.getTime()));
        d <= end;
        d.setDate(d.getDate() + 1)
      ) {
        if (dayNums.includes(d.getDay())) {
          sessions.push({
            date: d.toISOString().slice(0, 10),
            start_time,
            end_time,
          });
        }
      }

      res.json({ sessions });
    } catch (err) {
      console.error("Error generating upcoming sessions:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);


// Need to fetch these fields (for now we just hard code them in)
// "canvas_course_id": null,
//         "canvas_assignment_id": null

router.post(
  "/create-classroom",
  verifyToken,
  authorizeRoles("professor"),
  async (req, res) => {
    try {
      const {
        className,
        daysOfWeek,
        timeBlockId,
        startDate,
        endDate,
      } = req.body;

      // Validate required fields
      if (!className || !Array.isArray(daysOfWeek) || !timeBlockId || !startDate || !endDate) {
        return res.status(400).json({
          error: "Missing required fields: className, daysOfWeek[], timeBlockId, startDate, endDate",
        });
      }

      if (!req.user?.id) {
        return res
          .status(401)
          .json({ error: "Unauthorized: User ID is missing" });
      }

      const result = await pool.query(
        `INSERT INTO classrooms 
          (professor_id, class_name, days_of_week, time_block_id, start_date, end_date)
         VALUES 
          ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.user.id, className, daysOfWeek, timeBlockId, startDate, endDate]
      );

      res.status(201).json({
        message: "Classroom created successfully",
        classroom: result.rows[0],
      });
    } catch (err) {
      console.error("Error creating classroom:", err);
      res.status(500).json({ error: "Failed to create classroom" });
    }
  }
);


router.post(
  "/generate-qr",
  verifyToken,
  authorizeRoles("professor"),
  async (req, res) => {
    try {

      const { classroom_id } = req.body;

      if (!classroom_id) {
        return res.status(400).json({ error: "Classroom ID is required" });
      }

      const classroomResult = await pool.query(
        "SELECT * FROM classrooms WHERE id = $1 AND professor_id = $2",
        [classroom_id, req.user.id]
      );

      if (classroomResult.rows.length === 0) {
        return res.status(403).json({ error: "Unauthorized or classroom does not exist" });
      }

      const sessionId = `session_${Date.now()}`; // Unique session ID

      const createdAt = new Date();
      const sessionDate = createdAt.toISOString().split('T')[0]; // YYYY-MM-DD
      const expiresAt = new Date(createdAt.getTime() + 90 * 60 * 1000); // 90 mins later

      const qrData = `${process.env.URL}/attendance?session=${sessionId}`;
      const qrImage = await QRCode.toDataURL(qrData);


      // 2. Update class summaries by 1 total session 
      await pool.query(
        `UPDATE attendance_summary
       SET total_sessions = total_sessions + 1
      WHERE classroom_id = $1`,
        [classroom_id]
      );

      await pool.query(
        `INSERT INTO sessions (session_id, classroom_id, professor_id, session_date, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, classroom_id, req.user.id, sessionDate, expiresAt.toISOString()]
      );
      res.json({ qrImage, sessionId, sessionDate });
    } catch (err) {
      console.error("Error generating QR:", err);
      res.status(500).json({ error: "Failed to generate QR code" });
    }
  }
);


// this route will be triggered when the students cans the qr code and get TAKEN to the link with the sessionID in the URL
// they will need to be logged in, so that is why the verifyToken is in the statement.
router.post('/mark-attendance', verifyToken, authorizeRoles('student'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    const studentId = req.user.id;

    if (!sessionId) return res.status(400).json({ error: "No session ID provided" });

    // Ensure session exists and is valid and not expired.
    const sessionResult = await pool.query(
      "SELECT * FROM sessions WHERE session_id = $1 AND expires_at > NOW()",
      [sessionId]
    );

    // if (sessionResult.rows.length === 0) {
    //   return res.status(400).json({ error: "Invalid or expired session" });
    // }

    const { classroom_id } = sessionResult.rows[0];

    // 2. Canvas verification (if linked)
    const classroomResult = await pool.query(
      "SELECT * FROM classrooms WHERE id = $1",
      [classroom_id]
    );

    const classroom = classroomResult.rows[0];

    // if (classroom.canvas_course_id) {
    //   const canvasRoster = await canvasApi.get(
    //     `/courses/${classroom.canvas_course_id}/enrollments`,
    //     { params: { type: ['StudentEnrollment'] } }
    //   );

    //   const canvasMatch = canvasRoster.data.some(entry =>
    //     entry.user.login_id?.toLowerCase() === req.user.email.toLowerCase()
    //   );

    //   if (!canvasMatch) {
    //     return res.status(403).json({ error: "You are not enrolled in this Canvas course" });
    //   }
    // }
    // 3. Auto-enroll if not already
    await pool.query(
      `INSERT INTO enrollments (student_id, classroom_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING`,
      [studentId, classroom_id]
    );

    // 4. Auto-create attendance_summary if needed
    await pool.query(
      `INSERT INTO attendance_summary (student_id, classroom_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING`,
      [studentId, classroom_id]
    );

    // Check if student has already checked in
    const checkAttendance = await pool.query(
      "SELECT * FROM attendance WHERE session_id = $1 AND student_id = $2",
      [sessionId, studentId]
    );

    if (checkAttendance.rows.length > 0) {
      return res.status(400).json({ error: "Already checked in" });
    }


    // verify attendance location


    // Mark attendance
    const status = 'present';

    // 1. Insert raw attendance
    await pool.query(
      "INSERT INTO attendance (session_id, student_id, status) VALUES ($1, $2, $3)",
      [sessionId, studentId, status]
    );

    // 2. Update summary
    await pool.query(
      `UPDATE attendance_summary
       SET present_count = present_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE student_id = $1 AND classroom_id = $2`,
      [studentId, classroom_id]
    );

    // 3. Calculate new score
    const summary = await pool.query(
      `SELECT * FROM attendance_summary WHERE student_id = $1 AND classroom_id = $2`,
      [studentId, classroom_id]
    );

    const { total_sessions, present_count, late_count } = summary.rows[0];
    const grade = ((present_count + late_count * 0.8) / total_sessions) * 100;
    console.log("Attendance grade", grade.toFixed(2));

    // canvas api 
    // 4. Submit to Canvas (if linked — update below)
    // const canvasAssignmentId = 12345; // <-- replace with real assignmentId
    // const canvasCourseId = 67890;     // <-- replace with real courseId
    // await canvasApi.post(`/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions`, {
    //   submission: {
    //     user_id: studentId, // Canvas user ID
    //     posted_grade: grade.toFixed(2),
    //     submission_type: 'online_text_entry',
    //     body: `Auto-submitted attendance score: ${grade.toFixed(2)}%`
    //   }
    // });

    res.json({ message: "Attendance marked successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// STUDENT ROUTES [get all classes of that student]
router.get("/my-classes", verifyToken, authorizeRoles("student"), async (req, res) => {
  try {
    const studentId = req.user?.id;

    if (!studentId) {
      return res.status(401).json({ error: "Unauthorized: Missing user ID" });
    }

    const query =
      `SELECT c.id, c.class_name, c.start_date, c.end_date, tb.start_time, tb.end_time
      FROM enrollments e
      JOIN classrooms c ON e.classroom_id = c.id
      JOIN time_blocks tb ON c.time_block_id = tb.id
      WHERE e.student_id = $1
    ;`

    const { rows } = await pool.query(query, [studentId]);

    res.json({ classes: rows });
  }
  catch (err) {
    console.error("Error fetching student's classes:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get(
  "/my-next-sessions",
  verifyToken,
  authorizeRoles("student"),
  async (req, res) => {
    const studentId = req.user.id;

    try {
      // 1. Get all classrooms the student is enrolled in with time block info
      const query = `
        SELECT 
          c.id AS classroom_id,
          c.class_name,
          c.days_of_week,
          c.start_date,
          c.end_date,
          tb.start_time,
          tb.end_time
        FROM enrollments e
        JOIN classrooms c ON e.classroom_id = c.id
        JOIN time_blocks tb ON c.time_block_id = tb.id
        WHERE e.student_id = $1
      `;

      const { rows } = await pool.query(query, [studentId]);

      const classDayMap = { S: 0, M: 1, T: 2, W: 3, R: 4, F: 5, U: 6 };
      const today = new Date();
      const results = [];

      for (const row of rows) {
        const {
          classroom_id,
          class_name,
          days_of_week,
          start_date,
          end_date,
          start_time,
          end_time,
        } = row;

        const dayNums = days_of_week.map((d) => classDayMap[d]);
        const start = new Date(start_date);
        const end = new Date(end_date);

        // Start from today or class start date, whichever is later
        let d = new Date(Math.max(today.getTime(), start.getTime()));

        let nextSession = null;
        while (d <= end) {
          if (dayNums.includes(d.getDay())) {
            nextSession = {
              date: d.toISOString().slice(0, 10),
              start_time,
              end_time,
            };
            break;
          }
          d.setDate(d.getDate() + 1);
        }

        if (nextSession) {
          results.push({
            classroom_id,
            class_name,
            next_session: nextSession,
          });
        }
      }

      res.json({ sessions: results });
    } catch (err) {
      console.error("Error fetching upcoming sessions:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
