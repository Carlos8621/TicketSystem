require("dotenv").config();
const express = require("express");
const path = require("path");
const dbModule = require("./db");
const db = dbModule?.run ? dbModule : dbModule?.db;

if (!db || typeof db.run !== "function") {
  throw new Error("Database module did not export a sqlite3 Database instance.");
}

// Agrega columna company si no existe (si ya existe, ignoramos el error)
db.run(`ALTER TABLE users ADD COLUMN company TEXT`, () => {});

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { sendNewTicketEmail, sendTicketUpdateToCustomer } = require("./mailer");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ Falta JWT_SECRET en .env");
  process.exit(1);
}

const REQUEST_TYPES = ["Falla", "Solicitud"];
const SERVICES = ["Laptop", "PC", "Página Web"];
const STATUS_OPTIONS = ["Nuevo", "En progreso", "En espera", "Resuelto", "Cerrado"];

const ADMIN_ACCOUNTS = [
  { full_name: "Carlos_Ordaz", email: "carlos.ordaz@admin.local" },
  { full_name: "Brandon_Vargas", email: "brandon.vargas@admin.local" },
];

function nowISO() {
  return new Date().toISOString();
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      company: user.company || null,
      role: user.role || "user",
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const token = req.cookies?.auth;
  if (!token) return res.redirect("/login");
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.redirect("/login");
  }
}

function guestOnly(req, res, next) {
  const token = req.cookies?.auth;
  if (!token) return next();
  try {
    jwt.verify(token, JWT_SECRET);
    return res.redirect("/dashboard");
  } catch {
    return next();
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).send("Acceso denegado.");
  return next();
}

async function ensureAdminUsers() {
  const password_hash = await bcrypt.hash("1234", 12);

  await Promise.all(
    ADMIN_ACCOUNTS.map(
      (admin) =>
        new Promise((resolve) => {
          db.get(
            `SELECT id FROM users WHERE role = 'admin' AND full_name = ?`,
            [admin.full_name],
            (err, row) => {
              if (err) {
                console.error("Error buscando admin:", err.message);
                return resolve();
              }
              if (row?.id) return resolve();

              db.run(
                `INSERT INTO users (full_name, company, email, password_hash, role, created_at)
                 VALUES (?, ?, ?, ?, 'admin', ?)`,
                [admin.full_name, null, admin.email, password_hash, nowISO()],
                (err2) => {
                  if (err2) {
                    console.error("Error creando admin:", err2.message);
                  }
                  resolve();
                }
              );
            }
          );
        })
    )
  );
}

app.get("/", (req, res) => res.redirect("/dashboard"));

// --------- Auth ---------
app.get("/register", guestOnly, (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", guestOnly, async (req, res) => {
  const { full_name, company, email, password } = req.body || {};

  if (!full_name || !email || !password) {
    return res.render("register", { error: "Completa todos los campos." });
  }

  const password_hash = await bcrypt.hash(password, 12);
  const created_at = nowISO();

  db.run(
    `INSERT INTO users (full_name, company, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    [
      full_name.trim(),
      company?.trim() ? company.trim() : null,
      email.trim().toLowerCase(),
      password_hash,
      created_at,
    ],
    function (err2) {
      if (err2) {
        if (String(err2.message || "").includes("UNIQUE")) {
          return res.render("register", { error: "Ese email ya está registrado." });
        }
        return res.render("register", { error: "Error creando usuario." });
      }

      // Loguear automáticamente al usuario recién creado
      const user = {
        id: this.lastID,
        full_name: full_name.trim(),
        email: email.trim().toLowerCase(),
        company: company?.trim() ? company.trim() : null,
        role: "user",
      };

      const token = signToken(user);
      res.cookie("auth", token, { httpOnly: true, sameSite: "lax" });
      res.redirect("/dashboard");
    }
  );
});

app.get("/login", guestOnly, (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", guestOnly, (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.render("login", { error: "Completa todos los campos." });
  }

  const trimmed = identifier.trim();
  const email = trimmed.toLowerCase();
  const username = trimmed;

  db.get(
    `SELECT * FROM users WHERE email = ? OR (role = 'admin' AND LOWER(full_name) = LOWER(?))`,
    [email, username],
    async (err, user) => {
      if (err) return res.render("login", { error: "Error en login." });
      if (!user) return res.render("login", { error: "Usuario o contraseña incorrectos." });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.render("login", { error: "Usuario o contraseña incorrectos." });

      const token = signToken(user);
      res.cookie("auth", token, { httpOnly: true, sameSite: "lax" });
      res.redirect("/dashboard");
    }
  );
});

app.post("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login");
});

// --------- Tickets ---------
app.get("/dashboard", authRequired, (req, res) => {
  if (req.user.role === "admin") return res.redirect("/admin");
  db.all(
    `SELECT ticket_no, company, request_type, service, status, created_at, updated_at
     FROM tickets
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [req.user.id],
    (err, tickets) => {
      if (err) return res.status(500).send("Error cargando dashboard.");
      res.render("dashboard", { user: req.user, tickets: tickets || [] });
    }
  );
});

app.get("/admin", authRequired, adminRequired, (req, res) => {
  db.all(
    `SELECT t.ticket_no, t.company, t.request_type, t.service, t.status, t.created_at,
            u.full_name AS user_name, u.email AS user_email
     FROM tickets t
     JOIN users u ON t.user_id = u.id
     ORDER BY t.created_at DESC`,
    [],
    (err, tickets) => {
      if (err) return res.status(500).send("Error cargando administración.");
      res.render("admin_dashboard", { user: req.user, tickets: tickets || [] });
    }
  );
});

app.get("/tickets/new", authRequired, (req, res) => {
  res.render("ticket_new", {
    user: req.user,
    error: null,
    requestTypes: REQUEST_TYPES,
    services: SERVICES,
  });
});

function nextTicketNo(callback) {
  db.get(`SELECT COUNT(*) AS c FROM tickets`, [], (err, row) => {
    if (err) return callback(err);
    const n = (row?.c || 0) + 1;
    callback(null, `t_${String(n).padStart(3, "0")}`);
  });
}

app.post("/tickets", authRequired, (req, res) => {
  const { request_type, service, description } = req.body || {};
  const company = req.user.company || null;

  if (!REQUEST_TYPES.includes(request_type)) {
    return res.render("ticket_new", {
      user: req.user,
      error: "Tipo de solicitud inválido.",
      requestTypes: REQUEST_TYPES,
      services: SERVICES,
    });
  }
  if (!SERVICES.includes(service)) {
    return res.render("ticket_new", {
      user: req.user,
      error: "Servicio inválido.",
      requestTypes: REQUEST_TYPES,
      services: SERVICES,
    });
  }
  if (!description || !description.trim()) {
    return res.render("ticket_new", {
      user: req.user,
      error: "Describe la solicitud.",
      requestTypes: REQUEST_TYPES,
      services: SERVICES,
    });
  }

  nextTicketNo((err, ticket_no) => {
    if (err) return res.status(500).send("Error generando ticket.");
    const created_at = nowISO();
    const status = "Nuevo";

    db.run(
      `INSERT INTO tickets (ticket_no, user_id, company, request_type, service, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket_no,
        req.user.id,
        company,
        request_type,
        service,
        description.trim(),
        status,
        created_at,
        created_at,
      ],
      async function (err2) {
        if (err2) return res.status(500).send("Error creando ticket.");

        // Notificación por correo (si falla, no rompe el sistema)
        try {
          await sendNewTicketEmail({
            ticket_no,
            full_name: req.user.full_name,
            email: req.user.email,
            company,
            request_type,
            service,
            description: description.trim(),
          });
        } catch (e) {
          console.error("No se pudo enviar correo:", e.message);
        }

        res.redirect(`/tickets/${ticket_no}`);
      }
    );
  });
});

app.get("/tickets/:ticketNo", authRequired, (req, res) => {
  const { ticketNo } = req.params;
  const isAdmin = req.user.role === "admin";
  const baseQuery = isAdmin
    ? `SELECT t.ticket_no, t.company, t.request_type, t.service, t.description, t.status,
              t.created_at, t.updated_at, u.full_name AS user_name, u.email AS user_email
       FROM tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.ticket_no = ?`
    : `SELECT ticket_no, company, request_type, service, description, status, created_at, updated_at
       FROM tickets
       WHERE ticket_no = ? AND user_id = ?`;
  const params = isAdmin ? [ticketNo] : [ticketNo, req.user.id];

  db.get(baseQuery, params, (err, ticket) => {
    if (err) return res.status(500).send("Error leyendo ticket.");
    if (!ticket) return res.status(404).send("Ticket no encontrado.");

    const messagesQuery = isAdmin
      ? `SELECT author_type, author_name, body, is_internal, created_at
         FROM ticket_messages
         WHERE ticket_no = ?
         ORDER BY created_at ASC`
      : `SELECT author_type, author_name, body, is_internal, created_at
         FROM ticket_messages
         WHERE ticket_no = ? AND is_internal = 0
         ORDER BY created_at ASC`;

    db.all(messagesQuery, [ticketNo], (err2, messages) => {
      if (err2) return res.status(500).send("Error leyendo mensajes.");
      res.render("ticket_view", {
        user: req.user,
        ticket,
        messages: messages || [],
        statusOptions: STATUS_OPTIONS,
        isAdmin,
      });
    });
  });
});

app.post("/tickets/:ticketNo/status", authRequired, adminRequired, (req, res) => {
  const { ticketNo } = req.params;
  const { status } = req.body || {};
  if (!STATUS_OPTIONS.includes(status)) {
    return res.status(400).send("Estado inválido.");
  }

  db.run(
    `UPDATE tickets SET status = ?, updated_at = ? WHERE ticket_no = ?`,
    [status, nowISO(), ticketNo],
    (err) => {
      if (err) return res.status(500).send("Error actualizando estado.");
      res.redirect(`/tickets/${ticketNo}`);
    }
  );
});

app.post("/tickets/:ticketNo/messages", authRequired, (req, res) => {
  const { ticketNo } = req.params;
  const { body, send_email, internal_note } = req.body || {};
  if (!body || !body.trim()) {
    return res.status(400).send("El mensaje no puede ir vacío.");
  }

  const isAdmin = req.user.role === "admin";
  const authorType = isAdmin ? "admin" : "client";
  const authorName = req.user.full_name;
  const isInternal = isAdmin && internal_note === "on" ? 1 : 0;

  const ticketQuery = isAdmin
    ? `SELECT t.ticket_no, t.user_id, u.email AS user_email
       FROM tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.ticket_no = ?`
    : `SELECT ticket_no, user_id, NULL AS user_email
       FROM tickets
       WHERE ticket_no = ? AND user_id = ?`;
  const params = isAdmin ? [ticketNo] : [ticketNo, req.user.id];

  db.get(ticketQuery, params, (err, ticket) => {
    if (err) return res.status(500).send("Error leyendo ticket.");
    if (!ticket) return res.status(404).send("Ticket no encontrado.");

    db.run(
      `INSERT INTO ticket_messages (ticket_no, author_type, author_name, body, is_internal, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ticketNo, authorType, authorName, body.trim(), isInternal, nowISO()],
      async (err2) => {
        if (err2) return res.status(500).send("Error guardando mensaje.");

        db.run(
          `UPDATE tickets SET updated_at = ? WHERE ticket_no = ?`,
          [nowISO(), ticketNo],
          async (err3) => {
            if (err3) return res.status(500).send("Error actualizando ticket.");

            if (isAdmin && send_email === "on" && !isInternal && ticket.user_email) {
              try {
                await sendTicketUpdateToCustomer({
                  to: ticket.user_email,
                  ticket_no: ticketNo,
                  message: body.trim(),
                });
              } catch (e) {
                console.error("No se pudo enviar correo:", e.message);
              }
            }

            res.redirect(`/tickets/${ticketNo}`);
          }
        );
      }
    );
  });
});

app.post("/tickets/:ticketNo/delete", authRequired, adminRequired, (req, res) => {
  const { ticketNo } = req.params;
  db.serialize(() => {
    db.run(`DELETE FROM ticket_messages WHERE ticket_no = ?`, [ticketNo]);
    db.run(`DELETE FROM tickets WHERE ticket_no = ?`, [ticketNo], (err) => {
      if (err) return res.status(500).send("Error eliminando ticket.");
      res.redirect("/admin");
    });
  });
});

ensureAdminUsers()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Error inicializando admins:", err.message);
    app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
  });
