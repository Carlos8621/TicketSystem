require("dotenv").config();
const express = require("express");
const path = require("path");
const db = require("./db");

// Agrega columna company si no existe (si ya existe, ignoramos el error)
db.run(`ALTER TABLE users ADD COLUMN company TEXT`, () => {});

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { sendNewTicketEmail } = require("./mailer");

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
  const { email, password } = req.body || {};
  if (!email || !password) return res.render("login", { error: "Completa todos los campos." });

  db.get(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()], async (err, user) => {
    if (err) return res.render("login", { error: "Error en login." });
    if (!user) return res.render("login", { error: "Usuario o contraseña incorrectos." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.render("login", { error: "Usuario o contraseña incorrectos." });

    const token = signToken(user);
    res.cookie("auth", token, { httpOnly: true, sameSite: "lax" });
    res.redirect("/dashboard");
  });
});

app.post("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login");
});

// --------- Tickets ---------
app.get("/dashboard", authRequired, (req, res) => {
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
  db.get(
    `SELECT ticket_no, company, request_type, service, description, status, created_at, updated_at
     FROM tickets
     WHERE ticket_no = ? AND user_id = ?`,
    [ticketNo, req.user.id],
    (err, ticket) => {
      if (err) return res.status(500).send("Error leyendo ticket.");
      if (!ticket) return res.status(404).send("Ticket no encontrado.");
      res.render("ticket_view", { user: req.user, ticket });
    }
  );
});

app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
