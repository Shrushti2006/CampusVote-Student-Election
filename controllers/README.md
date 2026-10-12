# MVC organization
- `models/`: data shape and validation helpers for MongoDB collections.
- `controllers/`: request/business logic. `server.js` currently contains the legacy election/admin controller logic and route handlers to preserve the supplied UI/API compatibility.
- `routes/`: API route definitions are currently mounted in `server.js`; this is the next extraction point if expanding the project.
- `public/`: browser views (HTML/CSS/JS).

The existing app is a lightweight MVC-style Express app, not a full framework like NestJS. Student and attendance model helpers are provided in `models/`.
