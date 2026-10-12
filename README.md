# CampusVote — Student Election Portal

Express + MongoDB + vanilla HTML/CSS/JavaScript. The app includes student email OTP verification, SY/TY student registration, teacher-marked attendance, election scheduling, candidate management, one-vote-per-PRN enforcement, auto-counted results, and an admin-only database viewer.

## Requirements
- Node.js 18+ (recommended: current LTS)
- npm
- MongoDB Atlas cluster (or local MongoDB)
- A Gmail account with 2-Step Verification and a Google App Password for real email OTPs

## Install and run (VS Code terminal)
1. Extract this ZIP and open the `student_election_web` folder in VS Code.
2. Install packages:
   ```bash
   npm install
   ```
3. Create your environment file by copying `.env.example` to `.env` (PowerShell):
   ```powershell
   Copy-Item .env.example .env
   ```
4. Edit `.env` and set `MONGODB_URI`, `DB_NAME`, a strong `ADMIN_PASSWORD`, and a long random `ADMIN_TOKEN_SECRET`.
5. Configure email:
   - Set `EMAIL_PROVIDER=smtp`
   - Set `SMTP_USER` to the Gmail sender address
   - Set `SMTP_PASS` to the 16-character Google App Password (not your regular Gmail password)
   - Set `MAIL_FROM` to the same sender address
   - Keep `OTP_DEV_ECHO=false`
6. In MongoDB Atlas, allow your development IP under Network Access and ensure the database user has read/write access to the `campusvote` database.
7. Start the server:
   ```bash
   npm start
   ```
   For auto-restart while coding: `npm run dev`.
8. Open `http://localhost:3000`.

## First-time setup
1. Sign in as admin using the credentials from `.env` (`ADMIN_USERNAME` and `ADMIN_PASSWORD`). The first account is created on the first successful database startup. Change the password after setup.
2. Open **Student register & teacher attendance** from the student login page or visit `http://localhost:3000/attendance.html`.
3. Sign in with the admin account. This is the teacher/admin attendance access in this starter version.
4. Register each student with a unique roll number, full name and PRN. The students collection stores only these three fields (plus MongoDB's internal `_id`).
5. In the attendance panel, select SY/TY or both, tick the students who are present, and click **Save attendance**. Attendance is stored against the currently active election. Unticked students are saved as absent.
6. In the main admin dashboard, create/activate an election and set the voting start/end times, passcode, posts and candidates.
7. Students enter the election passcode, registered name and PRN, plus an email address to receive a one-time code. Email and class/year are not saved in the student register. After OTP verification, they can vote.

The app creates a demo election automatically if the database has no elections. Change its passcode and candidate list before use.

## Packages used
- `express` — HTTP server and API routes
- `mongodb` — MongoDB driver and indexes
- `dotenv` — load `.env` configuration
- `nodemailer` — send email OTPs through SMTP
- `nodemon` (development only) — restart the server when files change

## MVC-style layout
- `models/Student.js`, `models/Attendance.js` — data validation/document shape
- `server.js` — Express app, middleware, API handlers and startup (legacy election handlers remain here to keep the supplied UI compatible)
- `public/` — Views and browser-side JavaScript/CSS
- `controllers/`, `routes/` — reserved for extracting the remaining controller/route handlers as the project grows

This is a lightweight MVC-style Express app, not a full-stack framework. For a larger production system, move each route group from `server.js` into controller and router files.

## API additions
- `POST /api/admin/students` — register/update student (admin token required)
- `GET /api/admin/students` — list registered students (admin token required)
- `DELETE /api/admin/students/:prn` — remove student (admin token required)
- `GET /api/admin/attendance?classYear=SY|TY` — list attendance for active election
- `POST /api/admin/attendance` — save attendance entries for active election

## Important security notes
- Do not share `.env` or commit it to Git. The provided ZIP intentionally does not include `.env`.
- If an actual MongoDB URI/password was previously shared or uploaded, rotate that MongoDB database-user password in Atlas and update your local `.env`.
- Never use `EMAIL_PROVIDER=console` or `OTP_DEV_ECHO=true` for a real election; those are development-only.
- Admin results/database screens expose PRNs and each student's choices, as requested. This means the ballot is **not secret from admins**. If the election requires secret ballots, change the design so identity/attendance is stored separately from anonymous ballot choices.
- This starter app is suitable for learning/demo use. Have your college IT/security team review it before using it for an official election.
