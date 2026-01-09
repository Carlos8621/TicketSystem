const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./tickets.db");

db.serialize(() => {

  // ---------------- USERS ----------------
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      company TEXT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    )
  `);
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
      console.error("Error leyendo esquema de users:", err.message);
      return;
    }
    const hasRole = columns.some((column) => column.name === "role");
    if (!hasRole) {
      db.run(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
        (alterErr) => {
          if (alterErr) {
            console.error("Error agregando columna role:", alterErr.message);
          }
        }
      );
    }
  });

  // ---------------- TICKETS ----------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      company TEXT NULL,
      request_type TEXT NOT NULL,
      service TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // ---------------- TICKET MESSAGES ----------------
  db.run(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      author_type TEXT NOT NULL,       -- 'admin' | 'client'
      author_name TEXT NOT NULL,       -- Carlos_Ordaz / Brandon_Vargas / Cliente
      body TEXT NOT NULL,
      is_internal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

});

module.exports = db;
