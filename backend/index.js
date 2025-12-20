// ==========================================================
// VaiTerPlay - index.js PREMIUM (Webhook + Flow + Supabase + PIX)
// + Criptografia Híbrida para /flow-data (RSA-OAEP + AES-GCM)
// ==========================================================
console.log("[BOOT] index.js carregado de:", __filename);
console.log("[BOOT] CWD atual:", process.cwd());

require("dotenv").config();
const cors = require("cors");
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const mercadopago = require("mercadopago");
const cron = require("node-cron");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// ---------------------------------------------
// SUPABASE - INICIALIZAÇÃO + LOG DE DEBUG
// ---------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

console.log("[SUPABASE] URL:", supabaseUrl);
console.log("[SUPABASE] KEY definida?:", !!supabaseKey);

if (!supabaseUrl || !supabaseKey) {
  console.error("[SUPABASE] Variáveis de ambiente faltando ou inválidas!");
}


// Middleware: verifica o JWT do painel (Admin/Gestor)
function authPainel(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token não informado." });
    }

    const token = authHeader.split(" ")[1];

    if (!process.env.JWT_SECRET) {
      console.error("[AUTH] JWT_SECRET não definido no .env");
      return res
        .status(500)
        .json({ error: "Falha de configuração de segurança (JWT)." });
    }

    // Decodifica e valida o token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Aqui, assumo que gerarTokenPainel colocou pelo menos: id, nome, email, tipo
    req.usuarioPainel = {
      id: decoded.id,
      nome: decoded.nome,
      email: decoded.email,
      tipo: decoded.tipo,
    };

    next();
  } catch (err) {
    console.error("[AUTH] Erro ao validar token:", err);
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}
function gerarTokenAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sha256Hex(texto) {
  return crypto.createHash("sha256").update(texto).digest("hex");
}

// Regras simples de senha (nível médio)
function validarSenhaMedia(senha) {
  if (!senha || typeof senha !== "string") return "Senha inválida.";
  if (senha.length < 8) return "A senha deve ter no mínimo 8 caracteres.";
  if (!/[A-Za-z]/.test(senha) || !/[0-9]/.test(senha)) {
    return "A senha deve conter letras e números.";
  }
  return null;
}

/**
 * Envio de email: deixe pronto pra plugar provedor.
 * No DEV, a gente só imprime o link no console pra você testar.
 */
async function enviarEmail(to, subject, html) {
  const dev = String(process.env.EMAIL_DEV_MODE || "1") === "1";
  if (dev) {
    console.log("\n[EMAIL_DEV_MODE=1] Email NÃO enviado de verdade.");
    console.log("Para:", to);
    console.log("Assunto:", subject);
    console.log("Conteúdo (HTML):\n", html);
    console.log();
    return;
  }

  // Aqui você pluga Resend/SendGrid/SMTP.
  // Se quiser, eu te passo o bloco do Resend (bem simples).
  throw new Error(
    "Envio de email real não configurado. Defina EMAIL_DEV_MODE=1 para testar sem email."
  );
}

function getFrontendBaseUrl() {
  return (
    process.env.FRONTEND_BASE_URL ||
    "https://vaiterplay.netlify.app/" // ajuste se seu front roda em outra porta
  );
}

// Middleware: restringe por tipo de usuário (ADMIN, GESTOR etc.)
function permitirTipos(...tiposPermitidos) {
  return (req, res, next) => {
    if (!req.usuarioPainel || !req.usuarioPainel.tipo) {
      return res.status(401).json({ error: "Usuário não autenticado." });
    }

    // tipo do banco vem "ADMIN"/"GESTOR" → padroniza em maiúsculo
    const tipoUsuario = String(req.usuarioPainel.tipo).toUpperCase();

    if (!tiposPermitidos.includes(tipoUsuario)) {
      return res
        .status(403)
        .json({ error: "Você não tem permissão para acessar este recurso." });
    }

    next();
  };
}




// Vamos guardar os arquivos em memória para depois mandar pro Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024, // ~3MB por arquivo
    files: 3
  }
});
// =====================================================
// 2.1) HELPERS — Normalização de status (1x no topo)
// Padrão oficial do projeto: pending | paid | canceled
// Aceita legados: pendente/pago/cancelado (pt-BR) e variantes
// =====================================================
function normalizeReservaStatus(input) {
  const v = String(input || "").trim().toLowerCase();

  if (!v) return "pending";

  // Legados PT-BR / variações comuns
  if (v === "pendente" || v === "pending") return "pending";
  if (v === "pago" || v === "paid") return "paid";
  if (v === "cancelado" || v === "canceled" || v === "cancelled") return "canceled";

  // Outras variações (se algum dia aparecer algo diferente, cai em pending por segurança)
  if (v.includes("pend")) return "pending";
  if (v.includes("paid") || v.includes("pago")) return "paid";
  if (v.includes("cancel")) return "canceled";

  // fallback seguro
  return "pending";
}

function isReservaBloqueante(status) {
  const st = normalizeReservaStatus(status);
  return st === "pending" || st === "paid";
}

function isReservaCancelada(status) {
  return normalizeReservaStatus(status) === "canceled";
}


// ---------------------------------------------------------
// FUNÇÃO AUXILIAR: baixa imagem (Supabase) e converte em Base64
// ---------------------------------------------------------
async function fetchImageAsBase64(imageUrl) {
  try {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      console.error("[Base64] Erro HTTP ao buscar imagem:", response.status, imageUrl);
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      console.error("[Base64] Resposta não é imagem. content-type =", contentType);
      return "";
    }

    const buffer = await response.arrayBuffer();
    const base64String = Buffer.from(buffer).toString("base64");
    return `data:${contentType};base64,${base64String}`;
  } catch (e) {
    console.error("[Base64] Erro ao converter imagem:", e.message);
    return "";
  }
}




// -----------------------------------------
// 0. Carrega chave privada (RSA) da pasta whatsapp_flow_chaves
// -----------------------------------------
let PRIVATE_KEY;
try {
  const privateKeyPath = path.join(__dirname, "whatsapp_flow_chaves", "private.pem");
  PRIVATE_KEY = fs.readFileSync(privateKeyPath, "utf8");
  console.log("[CRYPTO] private.pem carregado com sucesso");
} catch (err) {
  console.error("[CRYPTO] ERRO ao carregar private.pem:", err.message);
  console.error("Certifique-se de que o arquivo whatsapp_flow_chaves/private.pem existe.");
  process.exit(1);
}

// -----------------------------------------
// 1. Variáveis de ambiente
// -----------------------------------------
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  WEBHOOK_VERIFY_TOKEN,
  APP_SECRET,
  WHATSAPP_PHONE_ID,
  WHATSAPP_TOKEN,
  FLOW_ID_AGENDAMENTO,
  FLOW_ID_MEUS_AGENDAMENTOS,
  MERCADOPAGO_ACCESS_TOKEN,
  PORT,
  JWT_SECRET
} = process.env;

if (!JWT_SECRET) {
  console.warn(
    "[AUTH] Atenção: JWT_SECRET não definido no .env. " +
      "Defina uma chave forte para os tokens do painel."
  );
}


console.log("[CONF] FLOW_ID_AGENDAMENTO =", FLOW_ID_AGENDAMENTO);
console.log("[CONF] FLOW_ID_MEUS_AGENDAMENTOS =", FLOW_ID_MEUS_AGENDAMENTOS);

// -----------------------------------------
// 2. Clientes externos (Supabase / Mercado Pago)
// -----------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const mpClient = new mercadopago.MercadoPagoConfig({
  accessToken: MERCADOPAGO_ACCESS_TOKEN
});
const mpPayment = new mercadopago.Payment(mpClient);

// -----------------------------------------
// 3. App Express
// -----------------------------------------
const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173",          // frontend Vite (local)
      "https://vaiterplay.netlify.app", // frontend Netlify (produção)
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


// Vamos parsear JSON normalmente em TODAS as rotas
// e, ao mesmo tempo, guardar o rawBody para validar
// a assinatura do /webhook.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);
// ==========================================================
// BLOCO LOGIN / AUTENTICAÇÃO PAINEL (Admin / Gestor)
// ==========================================================

/**
 * Gera um token JWT para o painel (Admin/Gestor),
 * usando os dados da tabela "gestores".
 */
function gerarTokenPainel(gestor) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("[AUTH] JWT_SECRET não definido no .env");
    throw new Error("JWT_SECRET não definido");
  }

  const payload = {
    id: gestor.id,
    tipo: gestor.tipo, // 'ADMIN' ou 'GESTOR'
    nome: gestor.nome,
    email: gestor.email,
  };

  return jwt.sign(payload, secret, { expiresIn: "8h" });
}

/**
 * Middleware genérico para proteger rotas do painel.
 * Lê o cabeçalho Authorization: Bearer <token>.
 */
function autenticarPainel(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !String(authHeader).startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não informado." });
  }

  const token = String(authHeader).split(" ")[1];
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("[AUTH] JWT_SECRET não definido no .env");
    return res
      .status(500)
      .json({ error: "Falha de configuração de segurança (JWT)." });
  }

  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded; // { id, tipo, nome, email, iat, exp }
    next();
  } catch (err) {
    console.error("[AUTH] Erro ao verificar token:", err.message);
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

/**
 * Middleware extra: garante que o usuário logado seja ADMIN.
 * Use nas rotas /admin/*.
 */
function garantirAdmin(req, res, next) {
  if (!req.user || req.user.tipo !== "ADMIN") {
    return res
      .status(403)
      .json({ error: "Acesso permitido apenas para ADMIN." });
  }
  return next();
}

/**
 * Rota de login do painel (Admin / Gestor).
 * Usa a tabela "gestores" (já existente).
 *
 * POST /auth/login
 * Body JSON: { "email": "exemplo@teste.com", "senha": "123456" }
 */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};

    if (!email || !senha) {
      return res
        .status(400)
        .json({ error: "Email e senha são obrigatórios." });
    }

    const emailNorm = String(email).trim().toLowerCase();

    const { data: gestores, error } = await supabase
      .from("gestores")
      .select("id, nome, email, senha_hash, tipo, status, precisa_trocar_senha")
      .eq("email", emailNorm)
      .limit(1);

    if (error) {
      console.error("[AUTH] Erro ao buscar gestor:", error);
      return res.status(500).json({ error: "Erro ao buscar usuário." });
    }

    const gestor = gestores && gestores[0];

    if (!gestor) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    if (gestor.status && String(gestor.status).toUpperCase() !== "ATIVO") {
      return res.status(403).json({
        error: "Usuário inativo. Fale com o administrador do sistema.",
      });
    }

    // ✅ PONTO CRÍTICO DO MODELO A:
    // Se ainda não tem senha definida, não tenta bcrypt.compare.
    if (!gestor.senha_hash) {
      return res.status(403).json({
        error:
          "Conta ainda não ativada (sem senha definida). Clique em 'Esqueci minha senha' para criar sua senha e acessar.",
      });
    }

    const senhaOk = await bcrypt.compare(String(senha), String(gestor.senha_hash));

    if (!senhaOk) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    if (gestor.tipo !== "ADMIN" && gestor.tipo !== "GESTOR") {
      console.warn("[AUTH] Usuário com tipo inesperado tentando logar:", gestor.tipo);
    }

    const token = gerarTokenPainel(gestor);

    return res.json({
      token,
      usuario: {
        id: gestor.id,
        nome: gestor.nome,
        email: gestor.email,
        tipo: (gestor.tipo || "GESTOR").toLowerCase(), // admin/gestor pro front
        precisa_trocar_senha: !!gestor.precisa_trocar_senha,
      },
    });
  } catch (err) {
    console.error("[AUTH] Erro inesperado no login:", err);
    return res.status(500).json({ error: "Erro interno no login." });
  }
});
// ======================================
// AUTH - RESETAR/CRIAR SENHA (Modelo A)
// POST /auth/resetar-senha
// Body: { email, token, novaSenha, confirmarSenha }
// ======================================
app.post("/auth/resetar-senha", async (req, res) => {
  try {
    const { email, token, novaSenha, confirmarSenha } = req.body || {};

    const emailNorm = String(email || "").trim().toLowerCase();
    const tokenStr = String(token || "").trim();

    if (!emailNorm || !tokenStr || !novaSenha || !confirmarSenha) {
      return res.status(400).json({
        error: "Email, token, novaSenha e confirmarSenha são obrigatórios.",
      });
    }

    if (String(novaSenha) !== String(confirmarSenha)) {
      return res.status(400).json({ error: "As senhas não conferem." });
    }

    // regra de senha nível médio (você já tem validarSenhaMedia)
    const erroSenha = validarSenhaMedia(String(novaSenha));
    if (erroSenha) {
      return res.status(400).json({ error: erroSenha });
    }

    // Busca gestor por email
    const { data: lista, error: selErr } = await supabase
      .from("gestores")
      .select(
        "id, nome, email, status, tipo, reset_token_hash, reset_token_expira_em"
      )
      .eq("email", emailNorm)
      .limit(1);

    if (selErr) {
      console.error("[AUTH/RESET] Erro ao buscar gestor:", selErr);
      return res.status(500).json({ error: "Erro ao buscar usuário." });
    }

    const gestor = lista && lista[0];
    if (!gestor) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    if (gestor.status && String(gestor.status).toUpperCase() !== "ATIVO") {
      return res.status(403).json({
        error: "Usuário inativo. Fale com o administrador do sistema.",
      });
    }

    // Valida token existente
    if (!gestor.reset_token_hash || !gestor.reset_token_expira_em) {
      return res.status(400).json({
        error:
          "Este link não é válido ou já foi usado. Solicite um novo em 'Esqueci minha senha'.",
      });
    }

    // Expiração
    const exp = new Date(gestor.reset_token_expira_em);
    if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
      return res.status(400).json({
        error: "Link expirado. Solicite um novo em 'Esqueci minha senha'.",
      });
    }

    // Confere hash do token
    const tokenHashRecebido = sha256Hex(tokenStr);
    if (tokenHashRecebido !== gestor.reset_token_hash) {
      return res.status(400).json({
        error:
          "Token inválido. Verifique se você copiou o link corretamente ou solicite um novo.",
      });
    }

    // Hash da nova senha
    const saltRounds = 10;
    const senhaHash = await bcrypt.hash(String(novaSenha), saltRounds);

    // Atualiza: define senha + limpa reset + desliga precisa_trocar_senha
    const { error: upErr } = await supabase
      .from("gestores")
      .update({
        senha_hash: senhaHash,
        reset_token_hash: null,
        reset_token_expira_em: null,
        precisa_trocar_senha: false,
      })
      .eq("id", gestor.id);

    if (upErr) {
      console.error("[AUTH/RESET] Erro ao atualizar senha:", upErr);
      return res.status(500).json({ error: "Erro ao atualizar senha." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[AUTH/RESET] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro interno ao resetar senha." });
  }
});
// ======================================
// AUTH - ESQUECI MINHA SENHA (Modelo A)
// POST /auth/esqueci-senha
// Body: { email }
// ======================================
app.post("/auth/esqueci-senha", async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();

    if (!emailNorm) {
      // resposta neutra (não revela nada)
      return res.json({ ok: true });
    }

    // Busca gestor por email
    const { data: lista, error: selErr } = await supabase
      .from("gestores")
      .select("id, nome, email, status")
      .eq("email", emailNorm)
      .limit(1);

    if (selErr) {
      console.error("[AUTH/ESQUECI] Erro ao buscar gestor:", selErr);
      // resposta neutra
      return res.json({ ok: true });
    }

    const gestor = lista && lista[0];

    // Se não existir ou estiver inativo → resposta neutra
    if (!gestor || String(gestor.status).toUpperCase() !== "ATIVO") {
      return res.json({ ok: true });
    }

    // Gera token reset
    const token = gerarTokenAleatorio(32);
    const tokenHash = sha256Hex(token);
    const expiraEm = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

    const { error: upErr } = await supabase
      .from("gestores")
      .update({
        reset_token_hash: tokenHash,
        reset_token_expira_em: expiraEm,
      })
      .eq("id", gestor.id);

    if (upErr) {
      console.error("[AUTH/ESQUECI] Erro ao salvar token:", upErr);
      // resposta neutra
      return res.json({ ok: true });
    }

    // Monta link
    const base = getFrontendBaseUrl();
    const link = `${base}/resetar-senha?email=${encodeURIComponent(
      gestor.email
    )}&token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.4;">
        <h2>Recuperação de senha – VaiTerPlay</h2>
        <p>Olá, ${gestor.nome}.</p>
        <p>Recebemos uma solicitação para criar ou redefinir sua senha.</p>
        <p>Clique no link abaixo para continuar:</p>
        <p><a href="${link}" target="_blank" rel="noreferrer">${link}</a></p>
        <p>Esse link expira em 1 hora.</p>
        <p>Se você não solicitou, ignore este email.</p>
      </div>
    `;

    await enviarEmail(gestor.email, "Recuperação de senha (VaiTerPlay)", html);

    const devMode = String(process.env.EMAIL_DEV_MODE || "1") === "1";
    return res.json({
      ok: true,
      link_dev: devMode ? link : undefined,
    });
  } catch (err) {
    console.error("[AUTH/ESQUECI] Erro inesperado:", err);
    // resposta neutra
    return res.json({ ok: true });
  }
});

// ======================================
// ROTAS ADMIN - GESTORES (RESUMO)
// - Retorna gestores + empresas/complexos vinculados
// - Busca com join se existir relação; senão faz merge em 2 queries (fallback)
// ======================================
app.get(
  "/admin/gestores-resumo",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      // 1) TENTA pegar com relação (se existir FK empresas.gestor_id -> gestores.id)
      const { data: dataJoin, error: errorJoin } = await supabase
        .from("gestores")
        .select(
          `
          id, nome, email, cpf, status, tipo, taxa_plataforma_global, senha_hash,
          empresas:empresas ( id, nome )
        `
        )
        .eq("tipo", "GESTOR")
        .order("nome", { ascending: true });

      if (!errorJoin) {
        return res.json(dataJoin || []);
      }

      // Se caiu aqui, provavelmente não existe relação definida/visível no PostgREST.
      console.warn(
        "[ADMIN/GESTORES-RESUMO] Join falhou, aplicando fallback (2 queries). Erro:",
        errorJoin
      );

      // 2) Fallback: busca gestores
      const { data: gs, error: e1 } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, status, tipo, taxa_plataforma_global, senha_hash")
        .eq("tipo", "GESTOR")
        .order("nome", { ascending: true });

      if (e1) {
        console.error("[ADMIN/GESTORES-RESUMO] Erro ao buscar gestores:", e1);
        return res.status(500).json({ error: "Erro ao buscar lista de gestores." });
      }

      const gestorIds = (gs || []).map((g) => g.id);
      if (gestorIds.length === 0) {
        return res.json([]);
      }

      // 3) Fallback: busca empresas vinculadas
      // ⚠️ IMPORTANTE: aqui assumimos que existe empresas.gestor_id
      const { data: emps, error: e2 } = await supabase
        .from("empresas")
        .select("id, nome, gestor_id")
        .in("gestor_id", gestorIds);

      if (e2) {
        console.error("[ADMIN/GESTORES-RESUMO] Erro ao buscar empresas:", e2);
        // Mesmo que empresas falhe, devolve gestores pelo menos
        return res.json((gs || []).map((g) => ({ ...g, empresas: [] })));
      }

      // 4) Merge
      const mapEmp = new Map();
      (emps || []).forEach((e) => {
        const arr = mapEmp.get(e.gestor_id) || [];
        arr.push({ id: e.id, nome: e.nome });
        mapEmp.set(e.gestor_id, arr);
      });

      const out = (gs || []).map((g) => ({
        ...g,
        empresas: mapEmp.get(g.id) || [],
      }));

      return res.json(out);
    } catch (err) {
      console.error("[ADMIN/GESTORES-RESUMO] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao buscar lista de gestores." });
    }
  }
);

// ======================================
// ADMIN - EDITAR GESTOR (status / taxa_plataforma_global)
// PUT /admin/gestores/:id
// Body: { status, taxa_plataforma_global }
// ======================================
app.put(
  "/admin/gestores/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const gestorId = req.params.id;
      const { status, taxa_plataforma_global } = req.body || {};

      if (!gestorId) {
        return res.status(400).json({ error: "ID do gestor é obrigatório." });
      }

      let statusNorm = status ? String(status).toUpperCase().trim() : null;
      if (statusNorm && !["ATIVO", "INATIVO"].includes(statusNorm)) {
        return res.status(400).json({ error: "Status inválido. Use ATIVO ou INATIVO." });
      }

      let taxa = null;
      if (taxa_plataforma_global !== undefined && taxa_plataforma_global !== null && taxa_plataforma_global !== "") {
        const n = Number(taxa_plataforma_global);
        if (Number.isNaN(n)) {
          return res.status(400).json({ error: "taxa_plataforma_global inválida." });
        }
        taxa = n;
      }

      const updatePayload = {};
      if (statusNorm) updatePayload.status = statusNorm;
      if (taxa_plataforma_global === "" || taxa_plataforma_global === null) {
        updatePayload.taxa_plataforma_global = null;
      } else if (taxa !== null) {
        updatePayload.taxa_plataforma_global = taxa;
      }

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Nada para atualizar." });
      }

      // Garante que só edita GESTOR (não mexe em ADMIN)
      const { data: alvo, error: alvoErr } = await supabase
        .from("gestores")
        .select("id, tipo")
        .eq("id", gestorId)
        .limit(1);

      if (alvoErr) {
        console.error("[ADMIN/EDITAR-GESTOR] Erro buscar alvo:", alvoErr);
        return res.status(500).json({ error: "Erro ao buscar gestor." });
      }

      const g = alvo && alvo[0];
      if (!g) {
        return res.status(404).json({ error: "Gestor não encontrado." });
      }
      if (String(g.tipo || "").toUpperCase() !== "GESTOR") {
        return res.status(403).json({ error: "Ação permitida apenas para usuários tipo GESTOR." });
      }

      const { data: updated, error: upErr } = await supabase
        .from("gestores")
        .update(updatePayload)
        .eq("id", gestorId)
        .select("id, nome, email, cpf, status, tipo, taxa_plataforma_global")
        .single();

      if (upErr) {
        console.error("[ADMIN/EDITAR-GESTOR] Erro update:", upErr);
        return res.status(500).json({ error: "Erro ao atualizar gestor." });
      }

      return res.json({ ok: true, gestor: updated });
    } catch (err) {
      console.error("[ADMIN/EDITAR-GESTOR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao atualizar gestor." });
    }
  }
);
// ======================================
// ADMIN - REENVIAR ATIVAÇÃO (Modelo A)
// POST /admin/gestores/:id/reenviar-ativacao
// Gera novo link para o gestor definir senha
// ======================================
app.post(
  "/admin/gestores/:id/reenviar-ativacao",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const gestorId = req.params.id;

      // 1) busca dados do gestor
      const { data: g, error: errGet } = await supabase
        .from("gestores")
        .select("id, nome, email, status, tipo, senha_hash")
        .eq("id", gestorId)
        .maybeSingle();

      if (errGet) {
        console.error("[ADMIN/REENVIAR-ATIVACAO] Erro buscar gestor:", errGet);
        return res.status(500).json({ error: "Erro ao buscar gestor." });
      }

      if (!g) {
        return res.status(404).json({ error: "Gestor não encontrado." });
      }

      if (String(g.tipo || "").toUpperCase() !== "GESTOR") {
        return res.status(400).json({ error: "Esse usuário não é do tipo GESTOR." });
      }

      if (g.status && String(g.status).toUpperCase() !== "ATIVO") {
        return res.status(403).json({ error: "Gestor está INATIVO. Reative para enviar ativação." });
      }

      // 2) gera token e salva hash + expiração (1h)
      const token = gerarTokenAleatorio(32);
      const tokenHash = sha256Hex(token);
      const expiraEm = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { error: errUp } = await supabase
        .from("gestores")
        .update({
          reset_token_hash: tokenHash,
          reset_token_expira_em: expiraEm,
        })
        .eq("id", g.id);

      if (errUp) {
        console.error("[ADMIN/REENVIAR-ATIVACAO] Erro salvar token:", errUp);
        return res.status(500).json({ error: "Falha ao gerar link de ativação." });
      }

      // 3) monta link pro front
      const base = getFrontendBaseUrl();
      const link = `${base}/resetar-senha?email=${encodeURIComponent(
        g.email
      )}&token=${encodeURIComponent(token)}`;

      // 4) envia email (ou dev mode imprime/retorna link_dev)
      const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.4;">
          <h2>Ative seu acesso ao VaiTerPlay</h2>
          <p>Olá, ${g.nome || "Gestor"}.</p>
          <p>Para definir sua senha e entrar no painel, clique no link abaixo:</p>
          <p><a href="${link}" target="_blank" rel="noreferrer">${link}</a></p>
          <p>Esse link expira em 1 hora.</p>
        </div>
      `;

      await enviarEmail(g.email, "Link de ativação (VaiTerPlay)", html);

      return res.json({
        ok: true,
        message:
          "Ativação reenviada. Se o email estiver configurado, o gestor receberá o link.",
        link_dev: String(process.env.EMAIL_DEV_MODE || "1") === "1" ? link : undefined,
      });
    } catch (err) {
      console.error("[ADMIN/REENVIAR-ATIVACAO] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao reenviar ativação." });
    }
  }
);


// ============================================================================
// BLOCO EMPRESAS - PAINEL ADMIN
// ============================================================================

// [ADMIN] Lista todas as empresas/complexos com taxa e status derivado
app.get(
  "/admin/empresas",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("empresas")
        .select(
          `
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          gestor_id,
          link_google_maps,
          link_site_ou_rede,
          ativo,
          taxa_plataforma,
          desativado_por_tipo,
          motivo_desativacao,
          created_at
          `
        )
        
        .order("nome", { ascending: true });

      if (error) {
        console.error("[ADMIN/EMPRESAS] Erro ao buscar empresas:", error);
        return res
          .status(500)
          .json({ error: "Erro ao buscar empresas (admin)." });
      }

      const empresasTratadas = (data || []).map((e) => ({
        ...e,
        // Campo derivado só para uso na tela ADMIN:
        status: e.ativo ? "ATIVO" : "BLOQUEADO",
      }));

      return res.json(empresasTratadas);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro inesperado em /admin/empresas (GET)." });
    }
  }
);


// [ADMIN] Cria nova empresa/complexo com taxa e vínculo a um gestor
app.post(
  "/admin/empresas",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const {
        nome,
        endereco_resumo,
        descricao_complexo = null,
        link_google_maps = null,
        link_site_ou_rede = null,
        gestor_id,
        taxa_plataforma = 0,
        ativo = true,
      } = req.body;

      if (!nome || !endereco_resumo || !gestor_id) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: nome, endereco_resumo e gestor_id em /admin/empresas (POST).",
        });
      }

      const taxaNumber = Number(taxa_plataforma);
      const taxaFinal = Number.isFinite(taxaNumber) ? taxaNumber : 0;

      const { data, error } = await supabase
        .from("empresas")
        .insert([
          {
            nome,
            endereco_resumo,
            descricao_complexo,
            link_google_maps,
            link_site_ou_rede,
            gestor_id,
            taxa_plataforma: taxaFinal,
            ativo: !!ativo,
            desativado_por_tipo: null,
            motivo_desativacao: null,
          },
        ])
        .select(
          `
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          gestor_id,
          link_google_maps,
          link_site_ou_rede,
          ativo,
          taxa_plataforma,
          desativado_por_tipo,
          motivo_desativacao,
          created_at
        `
        )
        .single();

      if (error) {
        console.error("[ADMIN/EMPRESAS] Erro ao criar empresa:", error);
        return res
          .status(500)
          .json({ error: "Erro ao criar empresa em /admin/empresas (POST)." });
      }

      return res.status(201).json(data);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS] Erro inesperado (POST):", err);
      return res
        .status(500)
        .json({ error: "Erro inesperado em /admin/empresas (POST)." });
    }
  }
);


// [ADMIN] Atualiza empresa/complexo (inclui taxa_plataforma, ativo e bloqueio)
app.put(
  "/admin/empresas/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        nome,
        endereco_resumo,
        descricao_complexo,
        link_google_maps,
        link_site_ou_rede,
        gestor_id,
        taxa_plataforma,
        ativo,
        motivo_desativacao, // opcional, só faz sentido quando ADMIN bloqueia
      } = req.body;

      if (!id) {
        return res.status(400).json({
          error: "Parâmetro :id é obrigatório em /admin/empresas/:id (PUT).",
        });
      }

      const updateFields = {};

      if (typeof nome === "string") updateFields.nome = nome;
      if (typeof endereco_resumo === "string")
        updateFields.endereco_resumo = endereco_resumo;
      if (typeof descricao_complexo === "string")
        updateFields.descricao_complexo = descricao_complexo;
      if (typeof link_google_maps === "string")
        updateFields.link_google_maps = link_google_maps;
      if (typeof link_site_ou_rede === "string")
        updateFields.link_site_ou_rede = link_site_ou_rede;
      if (typeof gestor_id === "string") updateFields.gestor_id = gestor_id;

      if (typeof taxa_plataforma !== "undefined") {
        const taxaNumber = Number(taxa_plataforma);
        updateFields.taxa_plataforma = Number.isFinite(taxaNumber)
          ? taxaNumber
          : 0;
      }

      // 🔒 Lógica de bloqueio / desbloqueio feita pelo ADMIN
      if (typeof ativo !== "undefined") {
        const ativoBool = !!ativo;
        updateFields.ativo = ativoBool;

        if (ativoBool) {
          // Admin REATIVOU: limpa desativação
          updateFields.desativado_por_tipo = null;
          updateFields.motivo_desativacao = null;
        } else {
          // Admin BLOQUEOU: marca como ADMIN
          updateFields.desativado_por_tipo = "ADMIN";
          if (typeof motivo_desativacao === "string") {
            updateFields.motivo_desativacao = motivo_desativacao;
          } else {
            updateFields.motivo_desativacao =
              "Bloqueado pelo administrador da plataforma.";
          }
        }
      }

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({
          error:
            "Nenhum campo válido enviado para atualização em /admin/empresas/:id (PUT).",
        });
      }

      const { data, error } = await supabase
        .from("empresas")
        .update(updateFields)
        .eq("id", id)
        .select(
          `
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          gestor_id,
          link_google_maps,
          link_site_ou_rede,
          ativo,
          taxa_plataforma,
          desativado_por_tipo,
          motivo_desativacao,
          created_at
        `
        )
        .single();

      if (error) {
        console.error("[ADMIN/EMPRESAS] Erro ao atualizar empresa:", error);
        return res.status(500).json({
          error: "Erro ao atualizar empresa em /admin/empresas/:id (PUT).",
        });
      }

      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS] Erro inesperado (PUT):", err);
      return res
        .status(500)
        .json({ error: "Erro inesperado em /admin/empresas/:id (PUT)." });
    }
  }
);
// =========================
// ADMIN — ROTAS EXTRA (CONSULTA / DETALHES / TROCA GESTOR / HARD DELETE) + AUDIT LOG
// COLE ESTE BLOCO **EXATAMENTE ABAIXO** DO SEU:
//    PUT /admin/empresas/:id
// (ANTES do bloco de gestores)
// =========================

// ---------- AUDIT LOG (compatível com o schema real) ----------
async function logAudit(req, payload = {}) {
  try {
    const usuario = req.usuarioPainel || req.user || {};

    const row = {
      actor_tipo: usuario.tipo || "DESCONHECIDO",
      actor_id: usuario.id || null,

      acao: payload.acao || "N/A",

      entidade_tipo: payload.entidade_tipo || payload.entidade || null,
      entidade_id: payload.entidade_id || null,

      resumo: payload.resumo || null,
      payload: payload.payload || payload.detalhes || null,

      created_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("audit_log").insert([row]);

    if (error) {
      console.warn("[AUDIT] Falha ao gravar audit_log:", error.message);
    }
  } catch (err) {
    console.warn("[AUDIT] Exceção ao gravar audit_log:", err?.message || err);
  }
}
// =========================
// ADMIN — AUDIT LOG (Histórico) + labels (nomes)
// GET /admin/audit-log?entidade_tipo=EMPRESA&entidade_id=...&limit=50
// Retorna itens com: actor_label e entidade_label
// =========================
app.get(
  "/admin/audit-log",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const entidade_tipo = (req.query.entidade_tipo || "")
        .toString()
        .trim()
        .toUpperCase();

      const entidade_id = (req.query.entidade_id || "").toString().trim();

      const limitRaw = Number(req.query.limit || 50);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 50;

      if (!entidade_tipo || !entidade_id) {
        return res.status(400).json({
          error:
            "Informe entidade_tipo e entidade_id. Ex.: /admin/audit-log?entidade_tipo=EMPRESA&entidade_id=UUID",
        });
      }

      // 1) Busca logs
      const { data, error } = await supabase
        .from("audit_log")
        .select(
          "id, created_at, actor_tipo, actor_id, acao, entidade_tipo, entidade_id, resumo, payload"
        )
        .eq("entidade_tipo", entidade_tipo)
        .eq("entidade_id", entidade_id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("[ADMIN/AUDIT-LOG] Erro:", error);
        return res
          .status(500)
          .json({ error: "Erro ao buscar histórico (audit_log)." });
      }

      const itens = Array.isArray(data) ? data : [];

      // 2) Coleta IDs para enriquecer labels
      const actorIds = [
        ...new Set(itens.map((x) => x.actor_id).filter(Boolean)),
      ];

      const entEmpresaIds = [
        ...new Set(
          itens
            .filter((x) => (x.entidade_tipo || "").toUpperCase() === "EMPRESA")
            .map((x) => x.entidade_id)
            .filter(Boolean)
        ),
      ];

      const entGestorIds = [
        ...new Set(
          itens
            .filter((x) => (x.entidade_tipo || "").toUpperCase() === "GESTOR")
            .map((x) => x.entidade_id)
            .filter(Boolean)
        ),
      ];

      const entQuadraIds = [
        ...new Set(
          itens
            .filter((x) => (x.entidade_tipo || "").toUpperCase() === "QUADRA")
            .map((x) => x.entidade_id)
            .filter(Boolean)
        ),
      ];

      // 3) Busca labels em lote (não quebra se faltar tabela/coluna)
      const mapGestores = new Map();
      const mapEmpresas = new Map();
      const mapQuadras = new Map();

      // 3.1 Gestores (actor + entidade GESTOR)
      const gestorIdsParaBuscar = [...new Set([...actorIds, ...entGestorIds])];
      if (gestorIdsParaBuscar.length) {
        const { data: gs, error: eG } = await supabase
          .from("gestores")
          .select("id, nome, email, cpf, status")
          .in("id", gestorIdsParaBuscar);

        if (eG) {
          console.warn("[ADMIN/AUDIT-LOG] Falha ao buscar gestores (labels):", eG.message);
        } else {
          (gs || []).forEach((g) => {
            const nome = g?.nome || "Gestor";
            const email = g?.email ? ` • ${g.email}` : "";
            const cpf = g?.cpf ? ` • ${g.cpf}` : "";
            const status = g?.status ? ` • ${String(g.status).toUpperCase()}` : "";
            mapGestores.set(g.id, `${nome}${email}${cpf}${status}`);
          });
        }
      }

      // 3.2 Empresas (entidade EMPRESA)
      if (entEmpresaIds.length) {
        const { data: emps, error: eE } = await supabase
          .from("empresas")
          .select("id, nome, slug, endereco_resumo, ativo, gestor_id")
          .in("id", entEmpresaIds);

        if (eE) {
          console.warn("[ADMIN/AUDIT-LOG] Falha ao buscar empresas (labels):", eE.message);
        } else {
          (emps || []).forEach((e) => {
            const nome = e?.nome || "Complexo";
            const slug = e?.slug ? ` • ${e.slug}` : "";
            const end = e?.endereco_resumo ? ` • ${e.endereco_resumo}` : "";
            const ativo = e?.ativo === false ? " • INATIVO" : " • ATIVO";
            mapEmpresas.set(e.id, `${nome}${slug}${end}${ativo}`);
          });
        }
      }

      // 3.3 Quadras (entidade QUADRA)
      // OBS: seu schema parece usar "informacoes" (e NÃO "nome")
      if (entQuadraIds.length) {
        const { data: qds, error: eQ } = await supabase
          .from("quadras")
          .select("id, informacoes, modalidade, status, empresa_id")
          .in("id", entQuadraIds);

        if (eQ) {
          console.warn("[ADMIN/AUDIT-LOG] Falha ao buscar quadras (labels):", eQ.message);
        } else {
          (qds || []).forEach((q) => {
            const titulo = q?.informacoes || "Quadra";
            const mod = q?.modalidade ? ` • ${q.modalidade}` : "";
            const st = q?.status ? ` • ${q.status}` : "";
            mapQuadras.set(q.id, `${titulo}${mod}${st}`);
          });
        }
      }

      // 4) Enriquecimento final por item
      const itensEnriquecidos = itens.map((x) => {
        const actorTipo = (x.actor_tipo || "").toString().trim().toUpperCase();

        // actor_label: tenta gestores; se não achar, fallback para tipo + id curto
        const actorLabel =
          (x.actor_id && mapGestores.get(x.actor_id)) ||
          (x.actor_id
            ? `${actorTipo || "ATOR"} • ${String(x.actor_id).slice(0, 8)}…`
            : (actorTipo || "ATOR"));

        // entidade_label por tipo
        const entTipo = (x.entidade_tipo || "").toString().trim().toUpperCase();
        let entidadeLabel = `${entTipo || "ENTIDADE"} • ${String(x.entidade_id || "").slice(0, 8)}…`;

        if (entTipo === "EMPRESA" && x.entidade_id) {
          entidadeLabel =
            mapEmpresas.get(x.entidade_id) || entidadeLabel;
        } else if (entTipo === "GESTOR" && x.entidade_id) {
          entidadeLabel =
            mapGestores.get(x.entidade_id) || entidadeLabel;
        } else if (entTipo === "QUADRA" && x.entidade_id) {
          entidadeLabel =
            mapQuadras.get(x.entidade_id) || entidadeLabel;
        }

        return {
          ...x,
          actor_label: actorLabel,
          entidade_label: entidadeLabel,
        };
      });

      // 5) loga o acesso ao histórico também (se você já usa logAudit)
      // (se logAudit não existir no seu arquivo, comente este trecho)
      try {
        await logAudit(req, {
          acao: "ADMIN_AUDIT_LOG_LIST",
          entidade_tipo,
          entidade_id,
          resumo: `Listou histórico: ${entidade_tipo} ${entidade_id}`,
          payload: { limit },
        });
      } catch (_) {}

      return res.json({
        entidade_tipo,
        entidade_id,
        itens: itensEnriquecidos,
      });
    } catch (err) {
      console.error("[ADMIN/AUDIT-LOG] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao buscar histórico." });
    }
  }
);

// =========================
// GET /admin/consulta?q=...
// → sugestões (gestores + empresas) por "contém"
// =========================
app.get(
  "/admin/consulta",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const qRaw = (req.query.q || "").toString().trim();
      const q = qRaw.length ? qRaw : "";

      if (!q || q.length < 2) {
        return res.json({
          q: qRaw,
          gestores: [],
          empresas: [],
          aviso: "Informe pelo menos 2 caracteres em ?q=...",
        });
      }

      // Gestores (por contém em nome/email/cpf se existir)
      // Ajuste campos conforme seu schema real.
      const gestoresQuery = supabase
        .from("gestores")
        .select("id, nome, email, cpf, tipo, status, created_at")
        .or(
          `nome.ilike.%${q}%,email.ilike.%${q}%,cpf.ilike.%${q}%`
        )
        .limit(10);

      // Empresas/complexos (por contém em nome/slug/endereco_resumo se existir)
      const empresasQuery = supabase
        .from("empresas")
        .select(
          "id, nome, slug, endereco_resumo, gestor_id, ativo, created_at"
        )
        .or(
          `nome.ilike.%${q}%,slug.ilike.%${q}%,endereco_resumo.ilike.%${q}%`
        )
        .limit(10);

      const [{ data: gestores, error: e1 }, { data: empresas, error: e2 }] =
        await Promise.all([gestoresQuery, empresasQuery]);

      if (e1) return res.status(500).json({ error: e1.message });
      if (e2) return res.status(500).json({ error: e2.message });

      await logAudit(req, {
        acao: "ADMIN_CONSULTA",
        entidade: "mix",
        detalhes: { q },
      });

      return res.json({
        q,
        gestores: gestores || [],
        empresas: empresas || [],
      });
    } catch (err) {
      console.error("[ADMIN/CONSULTA] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao consultar." });
    }
  }
);

// =========================
// GET /admin/gestores/:id/detalhe
// → gestor + empresas + quadras (contagem e lista essencial)
// =========================
app.get(
  "/admin/gestores/:id/detalhe",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const gestorId = req.params.id;

      const { data: gestor, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, tipo, status, created_at")
        .eq("id", gestorId)
        .maybeSingle();

      if (eG) return res.status(500).json({ error: eG.message });
      if (!gestor) return res.status(404).json({ error: "Gestor não encontrado." });

      const { data: empresas, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, slug, endereco_resumo, ativo, created_at")
        .eq("gestor_id", gestorId)
        .order("created_at", { ascending: false });

      if (eE) return res.status(500).json({ error: eE.message });

      const empresaIds = (empresas || []).map((x) => x.id);
      let quadras = [];
      if (empresaIds.length) {
        const { data: qd, error: eQ } = await supabase
          .from("quadras")
          .select("id, empresa_id, informacoes, tipo, modalidade, status, created_at")
          .in("empresa_id", empresaIds)
          .order("created_at", { ascending: false })
          .limit(200); // essencial (limite pra não explodir payload)

        if (eQ) return res.status(500).json({ error: eQ.message });
        quadras = qd || [];
      }

      await logAudit(req, {
        acao: "ADMIN_GESTOR_DETALHE",
        entidade: "gestores",
        entidade_id: gestorId,
      });

      return res.json({
        gestor,
        contagens: {
          empresas: (empresas || []).length,
          quadras: (quadras || []).length,
        },
        empresas: empresas || [],
        quadras: quadras || [],
      });
    } catch (err) {
      console.error("[ADMIN/GESTOR/DETALHE] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao buscar detalhe do gestor." });
    }
  }
);

// =========================
// GET /admin/empresas/:id/detalhe
// → empresa + gestor + quadras (e contagens)
// =========================
app.get(
  "/admin/empresas/:id/detalhe",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const empresaId = req.params.id;

      const { data: empresa, error: eE } = await supabase
        .from("empresas")
        .select(
          "id, nome, slug, endereco_resumo, descricao_complexo, link_google_maps, link_site_ou_rede, gestor_id, ativo, taxa_plataforma, created_at"
        )
        .eq("id", empresaId)
        .maybeSingle();

      if (eE) return res.status(500).json({ error: eE.message });
      if (!empresa) return res.status(404).json({ error: "Empresa/Complexo não encontrado." });

      const gestorId = empresa.gestor_id;

      const { data: gestor, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, tipo, status, created_at")
        .eq("id", gestorId)
        .maybeSingle();

      if (eG) return res.status(500).json({ error: eG.message });

      const { data: quadras, error: eQ } = await supabase
        .from("quadras")
        .select("id, empresa_id, informacoes, tipo, modalidade, status, created_at")
        .eq("empresa_id", empresaId)
        .order("created_at", { ascending: false });

      if (eQ) return res.status(500).json({ error: eQ.message });

      await logAudit(req, {
        acao: "ADMIN_EMPRESA_DETALHE",
        entidade: "empresas",
        entidade_id: empresaId,
      });

      return res.json({
        empresa,
        gestor: gestor || null,
        contagens: {
          quadras: (quadras || []).length,
        },
        quadras: quadras || [],
      });
    } catch (err) {
      console.error("[ADMIN/EMPRESA/DETALHE] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao buscar detalhe da empresa." });
    }
  }
);

// =========================
// POST /admin/empresas/:id/trocar-gestor
// body: { novoGestorId, motivo? }
// → troca gestor e migra quadras
// =========================
app.post(
  "/admin/empresas/:id/trocar-gestor",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const empresaId = req.params.id;
      const { novoGestorId, motivo } = req.body || {};

      if (!novoGestorId) {
        return res.status(400).json({ error: "Informe { novoGestorId }." });
      }

      // Confirma empresa existe
      const { data: empresa, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, gestor_id")
        .eq("id", empresaId)
        .maybeSingle();

      if (eE) return res.status(500).json({ error: eE.message });
      if (!empresa) return res.status(404).json({ error: "Empresa/Complexo não encontrado." });

      const gestorAnteriorId = empresa.gestor_id;

      // Confirma novo gestor existe
      const { data: novoGestor, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, ativo, tipo")
        .eq("id", novoGestorId)
        .maybeSingle();

      if (eG) return res.status(500).json({ error: eG.message });
      if (!novoGestor) return res.status(404).json({ error: "Novo gestor não encontrado." });

      // Atualiza empresa.gestor_id
      const { error: eU1 } = await supabase
        .from("empresas")
        .update({ gestor_id: novoGestorId })
        .eq("id", empresaId);

      if (eU1) return res.status(500).json({ error: eU1.message });

      // Migra quadras (se existir coluna gestor_id na tabela quadras)
      // Se não existir, essa parte falha com 42703 e a gente ignora.
      let migrouQuadras = false;
      const { error: eU2 } = await supabase
        .from("quadras")
        .update({ gestor_id: novoGestorId })
        .eq("empresa_id", empresaId);

      if (eU2) {
        // Se a coluna não existe, não vamos impedir o fluxo
        const msg = (eU2.message || "").toLowerCase();
        if (msg.includes("does not exist") || msg.includes("42703")) {
          migrouQuadras = false;
        } else {
          return res.status(500).json({ error: eU2.message });
        }
      } else {
        migrouQuadras = true;
      }

      await logAudit(req, {
        acao: "ADMIN_TROCAR_GESTOR_EMPRESA",
        entidade: "empresas",
        entidade_id: empresaId,
        detalhes: {
          gestorAnteriorId,
          novoGestorId,
          migrouQuadras,
          motivo: motivo || null,
        },
      });

      return res.json({
        ok: true,
        empresaId,
        gestorAnteriorId,
        novoGestorId,
        migrouQuadras,
      });
    } catch (err) {
      console.error("[ADMIN/EMPRESA/TROCAR-GESTOR] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao trocar gestor." });
    }
  }
);

// =========================
// DELETE /admin/empresas/:id
// → hard delete (com regra de segurança)
// Regras de segurança (deste bloco):
// 1) Exige ADMIN
// 2) Exige confirmação forte: ?confirm=DELETE
// 3) Se existir processamentos/reservas ativas (status != canceled) para quadras da empresa → bloqueia
// 4) Se existir env ADMIN_DELETE_KEY, exige header: x-admin-delete-key
// =========================
app.delete(
  "/admin/empresas/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const empresaId = req.params.id;

      const confirm = (req.query.confirm || "").toString().trim().toUpperCase();
      if (confirm !== "DELETE") {
        return res.status(400).json({
          error: "Confirmação obrigatória. Use: DELETE /admin/empresas/:id?confirm=DELETE",
        });
      }

      // “chave mestre” opcional via .env
      if (process.env.ADMIN_DELETE_KEY) {
        const key = (req.headers["x-admin-delete-key"] || "").toString().trim();
        if (!key || key !== process.env.ADMIN_DELETE_KEY) {
          return res.status(403).json({ error: "Chave de exclusão inválida." });
        }
      }

      // Confirma empresa existe
      const { data: empresa, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, gestor_id")
        .eq("id", empresaId)
        .maybeSingle();

      if (eE) return res.status(500).json({ error: eE.message });
      if (!empresa) return res.status(404).json({ error: "Empresa/Complexo não encontrado." });

      // Busca quadras da empresa
      const { data: quadras, error: eQ } = await supabase
        .from("quadras")
        .select("id")
        .eq("empresa_id", empresaId);

      if (eQ) return res.status(500).json({ error: eQ.message });

      const quadraIds = (quadras || []).map((q) => q.id);

      // Regra: se houver reservas “ativas” (qualquer status != canceled) bloqueia hard delete
      // (Se sua tabela/coluna for diferente, me diga e ajustamos)
      if (quadraIds.length) {
        const { data: reservaAtiva, error: eR } = await supabase
          .from("reservas")
          .select("id, status")
          .in("quadra_id", quadraIds)
          .not("status", "in", '("canceled","cancelado")')

          .limit(1);

        if (eR) {
          // Se não existir tabela reservas, não vai impedir (mas avisa no log)
          console.warn("[ADMIN/DELETE EMPRESA] Falha ao checar reservas:", eR.message);
        } else if (reservaAtiva && reservaAtiva.length) {
          return res.status(409).json({
            error:
              "Não posso apagar: existem reservas ativas (status diferente de 'canceled') vinculadas a quadras desta empresa.",
          });
        }
      }

      // Apaga dependências primeiro (ordem segura)
      // 1) quadras
      if (quadraIds.length) {
        const { error: eDq } = await supabase.from("quadras").delete().eq("empresa_id", empresaId);
        if (eDq) return res.status(500).json({ error: eDq.message });
      }

      // 2) empresa
      const { error: eDe } = await supabase.from("empresas").delete().eq("id", empresaId);
      if (eDe) return res.status(500).json({ error: eDe.message });

      await logAudit(req, {
        acao: "ADMIN_HARD_DELETE_EMPRESA",
        entidade: "empresas",
        entidade_id: empresaId,
        detalhes: {
          nome: empresa.nome,
          gestor_id: empresa.gestor_id,
          quadras_apagadas: quadraIds.length,
        },
      });

      return res.json({
        ok: true,
        empresaId,
        quadrasApagadas: quadraIds.length,
      });
    } catch (err) {
      console.error("[ADMIN/DELETE EMPRESA] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao apagar empresa." });
    }
  }
);

// ======================================================
// ADMIN - EMPRESAS (ações avançadas + consulta + auditoria)
// - BLOQUEAR / REATIVAR
// - REMOVER (soft / arquivar)
// - EXCLUIR (hard com trava)
// - CONSULTAR (busca "contém" + detalhes)
// ======================================================

// ---------- helpers (audit log) ----------
async function adminAuditLog({ adminId, acao, entidade_tipo, entidade_id, detalhes = null }) {
  // Se você ainda NÃO tiver a tabela admin_audit_logs, o código não pode quebrar o sistema.
  // Então: tentamos inserir; se falhar, apenas loga no console.
  try {
    await supabase.from("admin_audit_logs").insert([
      {
        admin_id: adminId,
        acao,
        entidade_tipo,
        entidade_id,
        detalhes,
      },
    ]);
  } catch (e) {
    console.warn("[AUDIT] Não foi possível gravar admin_audit_logs (ok por enquanto):", e?.message || e);
  }
}

// ---------- PATCH /admin/empresas/:id/bloquear ----------
app.patch(
  "/admin/empresas/:id/bloquear",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel?.id;
      const { id } = req.params;
      const { motivo } = req.body || {};

      if (!id) return res.status(400).json({ error: "Parâmetro :id é obrigatório." });

      const { data, error } = await supabase
        .from("empresas")
        .update({
          ativo: false,
          desativado_por_tipo: "ADMIN",
          motivo_desativacao:
            typeof motivo === "string" && motivo.trim() ? motivo.trim() : "Bloqueado pelo administrador.",
        })
        .eq("id", id)
        .select("id, nome, ativo, desativado_por_tipo, motivo_desativacao")
        .single();

      if (error || !data) {
        console.error("[ADMIN/EMPRESAS][BLOQUEAR] Erro:", error);
        return res.status(500).json({ error: "Erro ao bloquear empresa." });
      }

      await adminAuditLog({
        adminId,
        acao: "BLOQUEAR_EMPRESA",
        entidade_tipo: "EMPRESA",
        entidade_id: id,
        detalhes: { motivo: data.motivo_desativacao },
      });

      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS][BLOQUEAR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao bloquear empresa." });
    }
  }
);

// ---------- PATCH /admin/empresas/:id/reativar ----------
app.patch(
  "/admin/empresas/:id/reativar",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel?.id;
      const { id } = req.params;

      if (!id) return res.status(400).json({ error: "Parâmetro :id é obrigatório." });

      const { data, error } = await supabase
        .from("empresas")
        .update({
          ativo: true,
          desativado_por_tipo: null,
          motivo_desativacao: null,
        })
        .eq("id", id)
        .select("id, nome, ativo, desativado_por_tipo, motivo_desativacao")
        .single();

      if (error || !data) {
        console.error("[ADMIN/EMPRESAS][REATIVAR] Erro:", error);
        return res.status(500).json({ error: "Erro ao reativar empresa." });
      }

      await adminAuditLog({
        adminId,
        acao: "REATIVAR_EMPRESA",
        entidade_tipo: "EMPRESA",
        entidade_id: id,
      });

      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS][REATIVAR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao reativar empresa." });
    }
  }
);

// ---------- PATCH /admin/empresas/:id/arquivar (soft delete) ----------
app.patch(
  "/admin/empresas/:id/arquivar",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel?.id;
      const { id } = req.params;
      const { motivo } = req.body || {};

      if (!id) return res.status(400).json({ error: "Parâmetro :id é obrigatório." });

      const { data, error } = await supabase
        .from("empresas")
        .update({
          ativo: false,
          desativado_por_tipo: "ADMIN",
          motivo_desativacao:
            typeof motivo === "string" && motivo.trim() ? motivo.trim() : "Arquivado (soft) pelo administrador.",
        })
        .eq("id", id)
        .select("id, nome, ativo, desativado_por_tipo, motivo_desativacao")
        .single();

      if (error || !data) {
        console.error("[ADMIN/EMPRESAS][ARQUIVAR] Erro:", error);
        return res.status(500).json({ error: "Erro ao arquivar empresa." });
      }

      await adminAuditLog({
        adminId,
        acao: "ARQUIVAR_EMPRESA",
        entidade_tipo: "EMPRESA",
        entidade_id: id,
        detalhes: { motivo: data.motivo_desativacao },
      });

      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/EMPRESAS][ARQUIVAR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao arquivar empresa." });
    }
  }
);

// ---------- DELETE /admin/empresas/:id/excluir (hard delete com trava) ----------
// Regra "B" (segura): só exclui se NÃO tiver quadras vinculadas.
// (Se você quiser refinar depois: também checar reservas.)
app.delete(
  "/admin/empresas/:id/excluir",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel?.id;
      const { id } = req.params;

      if (!id) return res.status(400).json({ error: "Parâmetro :id é obrigatório." });

      // trava: não pode excluir se houver quadras vinculadas
      const { data: quadras, error: eQuadras } = await supabase
        .from("quadras")
        .select("id")
        .eq("empresa_id", id)
        .limit(1);

      if (eQuadras) {
        console.error("[ADMIN/EMPRESAS][EXCLUIR] Erro ao checar quadras:", eQuadras);
        return res.status(500).json({ error: "Erro ao validar exclusão (quadras)." });
      }

      if (Array.isArray(quadras) && quadras.length > 0) {
        return res.status(400).json({
          error:
            "Não é permitido EXCLUIR este complexo porque existem quadras vinculadas. Remova/realocar as quadras antes.",
        });
      }

      const { error } = await supabase.from("empresas").delete().eq("id", id);

      if (error) {
        console.error("[ADMIN/EMPRESAS][EXCLUIR] Erro ao excluir:", error);
        return res.status(500).json({ error: "Erro ao excluir empresa (hard)." });
      }

      await adminAuditLog({
        adminId,
        acao: "EXCLUIR_EMPRESA",
        entidade_tipo: "EMPRESA",
        entidade_id: id,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[ADMIN/EMPRESAS][EXCLUIR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao excluir empresa." });
    }
  }
);

// ---------- GET /admin/consultar?q= (busca "contém" em gestores e empresas) ----------
app.get(
  "/admin/consultar",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const qRaw = String(req.query.q || "").trim();
      const q = qRaw.length ? qRaw : "";

      if (!q || q.length < 1) {
        return res.json({ gestores: [], empresas: [] });
      }

      // Gestores (contém)
      const { data: gestores, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, status")
        .or(`nome.ilike.%${q}%,email.ilike.%${q}%,cpf.ilike.%${q}%`)
        .limit(20);

      if (eG) console.error("[ADMIN/CONSULTAR] erro gestores:", eG);

      // Empresas (contém)
      const { data: empresas, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, gestor_id, ativo, desativado_por_tipo")
        .ilike("nome", `%${q}%`)
        .limit(20);

      if (eE) console.error("[ADMIN/CONSULTAR] erro empresas:", eE);

      return res.json({
        gestores: Array.isArray(gestores) ? gestores : [],
        empresas: Array.isArray(empresas) ? empresas : [],
      });
    } catch (err) {
      console.error("[ADMIN/CONSULTAR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno em /admin/consultar." });
    }
  }
);

// ---------- GET /admin/consultar/gestor/:id (detalhe gestor + empresas + quadras) ----------
app.get(
  "/admin/consultar/gestor/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const { data: gestor, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, status, created_at")
        .eq("id", id)
        .single();

      if (eG || !gestor) return res.status(404).json({ error: "Gestor não encontrado." });

      const { data: empresas, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, ativo, desativado_por_tipo")
        .eq("gestor_id", id)
        .order("nome", { ascending: true });

      if (eE) console.error("[ADMIN/CONSULTAR/GESTOR] erro empresas:", eE);

      // Quadras do gestor (sem depender do Gestor module)
      const { data: quadras, error: eQ } = await supabase
        .from("quadras")
        .select("id, nome, empresa_id, status")
        .eq("gestor_id", id)
        .order("nome", { ascending: true });

      if (eQ) console.error("[ADMIN/CONSULTAR/GESTOR] erro quadras:", eQ);

      // Histórico (Admin actions) — últimas 20
      let audit = [];
      try {
        const { data: a } = await supabase
          .from("admin_audit_logs")
          .select("id, acao, entidade_tipo, entidade_id, detalhes, created_at")
          .order("created_at", { ascending: false })
          .limit(20);
        audit = Array.isArray(a) ? a : [];
      } catch (_) {}

      return res.json({
        gestor,
        empresas: Array.isArray(empresas) ? empresas : [],
        quadras: Array.isArray(quadras) ? quadras : [],
        audit,
      });
    } catch (err) {
      console.error("[ADMIN/CONSULTAR/GESTOR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao consultar gestor." });
    }
  }
);

// ---------- GET /admin/consultar/empresa/:id (detalhe empresa + gestor + quadras) ----------
app.get(
  "/admin/consultar/empresa/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const { data: empresa, error: eE } = await supabase
        .from("empresas")
        .select("id, nome, gestor_id, ativo, desativado_por_tipo, motivo_desativacao, created_at")
        .eq("id", id)
        .single();

      if (eE || !empresa) return res.status(404).json({ error: "Empresa/complexo não encontrado." });

      const { data: gestor, error: eG } = await supabase
        .from("gestores")
        .select("id, nome, email, cpf, status")
        .eq("id", empresa.gestor_id)
        .single();

      // Quadras da empresa
      const { data: quadras, error: eQ } = await supabase
        .from("quadras")
        .select("id, nome, status, gestor_id")
        .eq("empresa_id", id)
        .order("nome", { ascending: true });

      if (eQ) console.error("[ADMIN/CONSULTAR/EMPRESA] erro quadras:", eQ);

      let audit = [];
      try {
        const { data: a } = await supabase
          .from("admin_audit_logs")
          .select("id, acao, entidade_tipo, entidade_id, detalhes, created_at")
          .order("created_at", { ascending: false })
          .limit(20);
        audit = Array.isArray(a) ? a : [];
      } catch (_) {}

      return res.json({
        empresa,
        gestor: gestor || null,
        quadras: Array.isArray(quadras) ? quadras : [],
        audit,
      });
    } catch (err) {
      console.error("[ADMIN/CONSULTAR/EMPRESA] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao consultar empresa." });
    }
  }
);

// ======================================
// ADMIN - CRIAR GESTOR (Modelo A - ativação por link)
// POST /admin/gestores
// Body: { nome, email, telefone?, cpf, taxa_plataforma_global? }
// ======================================
app.post(
  "/admin/gestores",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { nome, email, telefone, cpf, taxa_plataforma_global } = req.body || {};

      const nomeNorm = String(nome || "").trim();
      const emailNorm = String(email || "").trim().toLowerCase();
      const cpfNorm = String(cpf || "").replace(/\D/g, "").trim();

      if (!nomeNorm || !emailNorm || !cpfNorm) {
        return res.status(400).json({ error: "Nome, email e CPF são obrigatórios." });
      }

      if (cpfNorm.length !== 11) {
        return res.status(400).json({ error: "CPF inválido (precisa ter 11 dígitos)." });
      }

      let taxa = null;
      if (taxa_plataforma_global !== undefined && taxa_plataforma_global !== null && taxa_plataforma_global !== "") {
        const n = Number(taxa_plataforma_global);
        if (Number.isNaN(n)) {
          return res.status(400).json({ error: "taxa_plataforma_global inválida." });
        }
        taxa = n;
      }

      // Checa duplicidade amigável (email e CPF)
      const { data: jaExiste, error: exErr } = await supabase
        .from("gestores")
        .select("id, email, cpf")
        .or(`email.eq.${emailNorm},cpf.eq.${cpfNorm}`)
        .limit(5);

      if (exErr) {
        console.error("[ADMIN/CRIAR-GESTOR] Erro checando duplicidade:", exErr);
        return res.status(500).json({ error: "Erro ao validar duplicidade." });
      }

      if (Array.isArray(jaExiste) && jaExiste.length > 0) {
        const temEmail = jaExiste.some((g) => String(g.email).toLowerCase() === emailNorm);
        const temCpf = jaExiste.some((g) => String(g.cpf) === cpfNorm);
        if (temEmail) return res.status(409).json({ error: "Já existe gestor com este email." });
        if (temCpf) return res.status(409).json({ error: "Já existe gestor com este CPF." });
      }

      // Gera token reset (ativação)
      const token = gerarTokenAleatorio(32);
      const tokenHash = sha256Hex(token);
      const expiraEm = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

      // Cria gestor SEM senha (senha_hash null)
      const insertPayload = {
        nome: nomeNorm,
        email: emailNorm,
        telefone: telefone ? String(telefone).trim() : null,
        cpf: cpfNorm,
        tipo: "GESTOR",
        status: "ATIVO",
        senha_hash: null,
        precisa_trocar_senha: true, // ✅ nasce exigindo definir/trocar senha
        taxa_plataforma_global: taxa, // null ou número
        reset_token_hash: tokenHash,
        reset_token_expira_em: expiraEm,
      };

      const { data: criado, error: insErr } = await supabase
        .from("gestores")
        .insert(insertPayload)
        .select("id, nome, email, cpf, status, tipo, taxa_plataforma_global, precisa_trocar_senha, created_at")
        .single();

      if (insErr) {
        console.error("[ADMIN/CRIAR-GESTOR] Erro insert:", insErr);
        const msg = String(insErr.message || "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("unique") || insErr.code === "23505") {
          return res.status(409).json({ error: "Email já cadastrado." });
        }
        return res.status(500).json({ error: "Erro ao criar gestor." });
      }

      // Link pro front
      const base = getFrontendBaseUrl();
      const link = `${base}/resetar-senha?email=${encodeURIComponent(
        emailNorm
      )}&token=${encodeURIComponent(token)}`;

      const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.4;">
          <h2>Bem-vindo ao VaiTerPlay</h2>
          <p>Olá, ${nomeNorm}.</p>
          <p>Para ativar seu acesso e criar sua senha, clique no link abaixo:</p>
          <p><a href="${link}" target="_blank" rel="noreferrer">${link}</a></p>
          <p>Esse link expira em 1 hora.</p>
        </div>
      `;

      await enviarEmail(emailNorm, "Ativar acesso (VaiTerPlay)", html);

      const devMode = String(process.env.EMAIL_DEV_MODE || "1") === "1";

      return res.status(201).json({
        ok: true,
        gestor: criado,
        link_dev: devMode ? link : undefined,
      });
    } catch (err) {
      console.error("[ADMIN/CRIAR-GESTOR] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao criar gestor." });
    }
  }
);

// ======================================
// AUTH - ESQUECI SENHA
// POST /auth/forgot
// Body: { email }
// Responde sempre ok=true (não vaza se email existe)
// ======================================
app.post("/auth/forgot", async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();

    if (!emailNorm) {
      return res.status(400).json({ error: "Informe o email." });
    }

    const { data: gestores, error } = await supabase
      .from("gestores")
      .select("id, nome, email, status")
      .eq("email", emailNorm)
      .limit(1);

    if (error) {
      console.error("[AUTH/FORGOT] Erro buscar gestor:", error);
      // não vaza detalhe
      return res.json({ ok: true });
    }

    const gestor = gestores && gestores[0];
    if (!gestor || (gestor.status && gestor.status !== "ATIVO")) {
      return res.json({ ok: true });
    }

    const token = gerarTokenAleatorio(32);
    const tokenHash = sha256Hex(token);
    const expiraEm = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

    const { error: upErr } = await supabase
      .from("gestores")
      .update({ reset_token_hash: tokenHash, reset_token_expira_em: expiraEm })
      .eq("id", gestor.id);

    if (upErr) {
      console.error("[AUTH/FORGOT] Erro salvar token:", upErr);
      return res.json({ ok: true });
    }

    const base = getFrontendBaseUrl();
    const link = `${base}/resetar-senha?email=${encodeURIComponent(
      gestor.email
    )}&token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.4;">
        <h2>Redefinição de senha – VaiTerPlay</h2>
        <p>Olá, ${gestor.nome}.</p>
        <p>Para redefinir sua senha, clique no link abaixo:</p>
        <p><a href="${link}" target="_blank" rel="noreferrer">${link}</a></p>
        <p>Esse link expira em 1 hora.</p>
      </div>
    `;

    await enviarEmail(gestor.email, "Redefinir senha (VaiTerPlay)", html);

    return res.json({
      ok: true,
      link_dev: String(process.env.EMAIL_DEV_MODE || "1") === "1" ? link : undefined,
    });
  } catch (err) {
    console.error("[AUTH/FORGOT] Erro inesperado:", err);
    return res.json({ ok: true });
  }
});
// ======================================
// AUTH - RESETAR SENHA (serve para ativação e "esqueci senha")
// POST /auth/reset
// Body: { email, token, novaSenha }
// ======================================
app.post("/auth/reset", async (req, res) => {
  try {
    const { email, token, novaSenha } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();
    const tokenStr = String(token || "").trim();

    if (!emailNorm || !tokenStr || !novaSenha) {
      return res.status(400).json({ error: "Email, token e nova senha são obrigatórios." });
    }

    const msgSenha = validarSenhaMedia(novaSenha);
    if (msgSenha) return res.status(400).json({ error: msgSenha });

    const { data: gestores, error } = await supabase
      .from("gestores")
      .select("id, email, reset_token_hash, reset_token_expira_em, status")
      .eq("email", emailNorm)
      .limit(1);

    if (error) {
      console.error("[AUTH/RESET] Erro buscar gestor:", error);
      return res.status(400).json({ error: "Link inválido ou expirado." });
    }

    const gestor = gestores && gestores[0];
    if (!gestor || (gestor.status && gestor.status !== "ATIVO")) {
      return res.status(400).json({ error: "Link inválido ou expirado." });
    }

    if (!gestor.reset_token_hash || !gestor.reset_token_expira_em) {
      return res.status(400).json({ error: "Link inválido ou expirado." });
    }

    const agora = Date.now();
    const exp = new Date(gestor.reset_token_expira_em).getTime();
    if (!exp || agora > exp) {
      return res.status(400).json({ error: "Link expirado. Solicite novamente." });
    }

    const tokenHash = sha256Hex(tokenStr);
    if (tokenHash !== gestor.reset_token_hash) {
      return res.status(400).json({ error: "Link inválido ou expirado." });
    }

    const novoHash = await bcrypt.hash(novaSenha, 10);

    const { error: upErr } = await supabase
      .from("gestores")
      .update({
        senha_hash: novoHash,
        reset_token_hash: null,
        reset_token_expira_em: null,
        precisa_trocar_senha: false,
      })
      .eq("id", gestor.id);

    if (upErr) {
      console.error("[AUTH/RESET] Erro salvar senha:", upErr);
      return res.status(500).json({ error: "Erro ao salvar nova senha." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[AUTH/RESET] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro interno ao redefinir senha." });
  }
});
// ======================================
// AUTH - TROCAR SENHA LOGADO
// POST /auth/change-password
// Body: { senhaAtual, novaSenha }
// ======================================
app.post("/auth/change-password", authPainel, async (req, res) => {
  try {
    const userId = req.usuarioPainel?.id;
    const { senhaAtual, novaSenha } = req.body || {};

    if (!userId) return res.status(401).json({ error: "Não autenticado." });
    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ error: "Senha atual e nova senha são obrigatórias." });
    }

    const msgSenha = validarSenhaMedia(novaSenha);
    if (msgSenha) return res.status(400).json({ error: msgSenha });

    const { data, error } = await supabase
      .from("gestores")
      .select("id, senha_hash")
      .eq("id", userId)
      .limit(1);

    if (error) return res.status(500).json({ error: "Erro ao buscar usuário." });

    const gestor = data && data[0];
    if (!gestor?.senha_hash) return res.status(400).json({ error: "Usuário ainda não tem senha definida." });

    const ok = await bcrypt.compare(senhaAtual, gestor.senha_hash);
    if (!ok) return res.status(401).json({ error: "Senha atual incorreta." });

    const novoHash = await bcrypt.hash(novaSenha, 10);

    const { error: upErr } = await supabase
      .from("gestores")
      .update({ senha_hash: novoHash, precisa_trocar_senha: false })
      .eq("id", userId);

    if (upErr) return res.status(500).json({ error: "Erro ao atualizar senha." });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[AUTH/CHANGE-PASSWORD] Erro:", err);
    return res.status(500).json({ error: "Erro interno." });
  }
});


// ============================================================================
// BLOCO EMPRESAS - PAINEL GESTOR (SEM EXIBIR TAXA_PLATAFORMA)
// ============================================================================

// Lista empresas/complexos vinculados ao GESTOR logado
app.get(
  "/gestor/empresas",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;

      const { data, error } = await supabase
        .from("empresas")
        .select(
          `
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          link_google_maps,
          link_site_ou_rede,
          gestor_id,
          ativo,
          created_at
          `
        )
        .eq("gestor_id", gestorId)
        .order("nome", { ascending: true });

      if (error) {
        console.error("[GESTOR/EMPRESAS] Erro ao buscar empresas:", error);
        return res
          .status(500)
          .json({ error: "Erro ao buscar empresas (gestor)." });
      }

      // Aqui não precisamos mais remover taxa_plataforma
      const empresasTratadas = data || [];

      console.log(
        `[GESTOR/EMPRESAS] ${empresasTratadas.length} empresas retornadas para gestor ${gestorId}`
      );

      return res.json(empresasTratadas);
    } catch (err) {
      console.error("[GESTOR/EMPRESAS] Erro inesperado em /gestor/empresas:", err);
      return res
        .status(500)
        .json({ error: "Erro inesperado em /gestor/empresas." });
    }
  }
);



// Cria empresa vinculada ao GESTOR logado
app.post(
  "/gestor/empresas",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;

      const {
        nome,
        endereco_resumo,
        link_google_maps,
        link_site_ou_rede,
        descricao_complexo,
      } = req.body;

      if (!nome || !endereco_resumo) {
        return res.status(400).json({
          error: "Campos obrigatórios: nome e endereco_resumo.",
        });
      }

      const payload = {
        nome,
        endereco_resumo,
        link_google_maps: link_google_maps || null,
        link_site_ou_rede: link_site_ou_rede || null,
        descricao_complexo: descricao_complexo || null,
        gestor_id: gestorId,
        ativo: true,
      };

      const { data, error } = await supabase
        .from("empresas")
        .insert([payload])
        .select()
        .single();

      if (error) {
        console.error("[GESTOR/EMPRESAS] Erro ao criar empresa:", error);
        return res
          .status(500)
          .json({ error: "Erro ao criar empresa (gestor)." });
      }

      return res.status(201).json(data);
    } catch (err) {
      console.error("[GESTOR/EMPRESAS] Erro inesperado ao criar empresa:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao criar empresa (gestor)." });
    }
  }
);

// Detalha uma empresa/complexo do GESTOR logado (para edição)
app.get(
  "/gestor/empresas/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id } = req.params;

      if (!id) {
        return res
          .status(400)
          .json({ error: "Parâmetro :id é obrigatório em /gestor/empresas/:id (GET)." });
      }

      const { data, error } = await supabase
        .from("empresas")
        .select(`
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          link_google_maps,
          link_site_ou_rede,
          gestor_id,
          ativo,
          created_at
        `)
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .single();

      if (error || !data) {
        console.error("[GESTOR/EMPRESAS] Erro ao buscar empresa para edição:", error);
        return res
          .status(404)
          .json({ error: "Empresa não encontrada para este gestor." });
      }

      return res.json(data);
    } catch (err) {
      console.error("[GESTOR/EMPRESAS] Erro inesperado em GET /gestor/empresas/:id:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao buscar empresa do gestor." });
    }
  }
);

// Atualiza campos básicos de uma empresa/complexo do GESTOR logado
// 🔒 Gestor NÃO altera taxa_plataforma
app.put(
  "/gestor/empresas/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id } = req.params;

      if (!id) {
        return res
          .status(400)
          .json({ error: "Parâmetro :id é obrigatório em /gestor/empresas/:id (PUT)." });
      }

      const { data: empresaExistente, error: errorEmpresa } = await supabase
        .from("empresas")
        .select("id, gestor_id")
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .single();

      if (errorEmpresa || !empresaExistente) {
        console.error(
          "[GESTOR/EMPRESAS] Empresa não encontrada ou não pertence ao gestor:",
          errorEmpresa
        );
        return res
          .status(404)
          .json({ error: "Empresa não encontrada para este gestor." });
      }

      const {
        nome,
        endereco_resumo,
        descricao_complexo,
        link_google_maps,
        link_site_ou_rede,
      } = req.body;

      const updateFields = {};

      if (typeof nome === "string") updateFields.nome = nome;
      if (typeof endereco_resumo === "string") {
        updateFields.endereco_resumo = endereco_resumo;
      }
      if (typeof descricao_complexo === "string") {
        updateFields.descricao_complexo = descricao_complexo;
      }
      if (typeof link_google_maps === "string") {
        updateFields.link_google_maps = link_google_maps || null;
      }
      if (typeof link_site_ou_rede === "string") {
        updateFields.link_site_ou_rede = link_site_ou_rede || null;
      }

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({
          error:
            "Nenhum campo válido enviado para atualização em /gestor/empresas/:id (PUT).",
        });
      }

      const { data, error } = await supabase
        .from("empresas")
        .update(updateFields)
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .select(`
          id,
          nome,
          endereco_resumo,
          descricao_complexo,
          link_google_maps,
          link_site_ou_rede,
          gestor_id,
          ativo,
          created_at
        `)
        .single();

      if (error) {
        console.error("[GESTOR/EMPRESAS] Erro ao atualizar empresa:", error);
        return res
          .status(500)
          .json({ error: "Erro ao atualizar empresa (gestor)." });
      }

      return res.json(data);
    } catch (err) {
      console.error("[GESTOR/EMPRESAS] Erro inesperado em PUT /gestor/empresas/:id:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao atualizar empresa do gestor." });
    }
  }
);
// GESTOR desativa um complexo/empresa (soft delete)
// - Marca ativo = false
// - desativado_por_tipo = 'GESTOR'
// - motivo_desativacao opcional
app.patch(
  "/gestor/empresas/:id/desativar",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id } = req.params;
      const { motivo } = req.body || {};

      if (!id) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/empresas/:id/desativar (PATCH).",
        });
      }

      console.log(
        "[GESTOR/EMPRESAS][DESATIVAR] Gestor",
        gestorId,
        "tentando desativar empresa",
        id
      );

      const { data, error } = await supabase
        .from("empresas")
        .update({
          ativo: false,
          desativado_por_tipo: "GESTOR",
          motivo_desativacao:
            typeof motivo === "string" && motivo.trim().length > 0
              ? motivo.trim()
              : "Desativado pelo gestor.",
        })
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          nome,
          ativo,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error || !data) {
        console.error(
          "[GESTOR/EMPRESAS][DESATIVAR] Erro ao atualizar empresa:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao desativar empresa (gestor)." });
      }

      console.log(
        "[GESTOR/EMPRESAS][DESATIVAR] Empresa desativada com sucesso:",
        data
      );

      return res.json(data);
    } catch (err) {
      console.error(
        "[GESTOR/EMPRESAS][DESATIVAR] Erro inesperado:",
        err
      );
      return res
        .status(500)
        .json({ error: "Erro interno ao desativar empresa do gestor." });
    }
  }
);

// GESTOR tenta reativar um complexo/empresa
// - Só permite se NÃO estiver desativado_por_tipo = 'ADMIN'
app.patch(
  "/gestor/empresas/:id/reativar",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/empresas/:id/reativar (PATCH).",
        });
      }

      // Busca empresa e garante que pertence ao gestor
      const { data: empresa, error: errorEmpresa } = await supabase
        .from("empresas")
        .select(
          `
          id,
          gestor_id,
          ativo,
          desativado_por_tipo
        `
        )
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .single();

      if (errorEmpresa || !empresa) {
        console.error(
          "[GESTOR/EMPRESAS] Empresa não encontrada para reativação:",
          errorEmpresa
        );
        return res
          .status(404)
          .json({ error: "Empresa não encontrada para este gestor." });
      }

      // Se ADMIN bloqueou, gestor não reativa
      if (empresa.desativado_por_tipo === "ADMIN") {
        return res.status(403).json({
          error:
            "Este complexo foi bloqueado pelo administrador da plataforma. Fale com o suporte.",
        });
      }

      const { data, error } = await supabase
        .from("empresas")
        .update({
          ativo: true,
          desativado_por_tipo: null,
          motivo_desativacao: null,
        })
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          nome,
          ativo,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error) {
        console.error("[GESTOR/EMPRESAS] Erro ao reativar empresa:", error);
        return res
          .status(500)
          .json({ error: "Erro ao reativar empresa (gestor)." });
      }

      return res.json(data);
    } catch (err) {
      console.error(
        "[GESTOR/EMPRESAS] Erro inesperado em PATCH /gestor/empresas/:id/reativar:",
        err
      );
      return res
        .status(500)
        .json({ error: "Erro interno ao reativar empresa do gestor." });
    }
  }
);
// ======================================
// ROTAS ADMIN - QUADRAS (GLOBAL)
// - Admin vê/cria/edita/desativa/reativa/exclui (soft delete) qualquer quadra
// - Admin escolhe a EMPRESA; gestor_id é inferido automaticamente (empresa.gestor_id)
// - Admin pode definir taxa_plataforma_override (se preenchida, sobrescreve a taxa global do gestor)
// ======================================

// Helper: busca empresa e valida
async function adminBuscarEmpresaOuFalhar(empresaId) {
  const { data: empresa, error } = await supabase
    .from("empresas")
    .select("id, nome, gestor_id, ativo")
    .eq("id", empresaId)
    .maybeSingle();

  if (error) return { error: error.message, status: 500 };
  if (!empresa) return { error: "Empresa/Complexo não encontrado.", status: 404 };
  if (!empresa.gestor_id)
    return {
      error: "Esta empresa não possui gestor vinculado (gestor_id vazio).",
      status: 400,
    };
  if (empresa.ativo === false)
    return {
      error:
        "Empresa/Complexo está desativado. Reative a empresa antes de cadastrar/editar quadras.",
      status: 400,
    };

  return { empresa };
}

// Lista global de quadras
// GET /admin/quadras?empresaId=&gestorId=&status=&q=&incluirExcluidas=1
app.get("/admin/quadras", authPainel, permitirTipos("ADMIN"), async (req, res) => {
  try {
    const { empresaId, gestorId, status, q, incluirExcluidas } = req.query;

    let query = supabase
      .from("quadras")
      .select(
        `
        id,
        empresa_id,
        gestor_id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
        desativado_por_tipo,
        motivo_desativacao,
        taxa_plataforma_override,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        created_at,
        empresa:empresas(id,nome,endereco_resumo,gestor_id),
        gestor:gestores(id,nome)
      `
      )
      .order("created_at", { ascending: false });

    if (empresaId) query = query.eq("empresa_id", empresaId);
    if (gestorId) query = query.eq("gestor_id", gestorId);
    if (status) query = query.eq("status", status);

    // Soft delete: por padrão, escondemos status=excluida (se você optar por usar isso)
    if (!String(incluirExcluidas || "").trim()) {
      query = query.neq("status", "excluida");
    }

    // busca simples (ilike) em tipo/material/modalidade
    if (q && String(q).trim()) {
      const qq = `%${String(q).trim()}%`;
      query = query.or(
        `tipo.ilike.${qq},material.ilike.${qq},modalidade.ilike.${qq}`
      );
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json(data || []);
  } catch (err) {
    console.error("[ADMIN/QUADRAS][GET] Erro:", err);
    return res.status(500).json({ error: "Erro interno ao listar quadras (admin)." });
  }
});

// Detalhe (para edição)
// GET /admin/quadras/:id
app.get("/admin/quadras/:id", authPainel, permitirTipos("ADMIN"), async (req, res) => {
  try {
    const quadraId = req.params.id;

    const { data, error } = await supabase
      .from("quadras")
      .select(
        `
        id,
        empresa_id,
        gestor_id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
        desativado_por_tipo,
        motivo_desativacao,
        taxa_plataforma_override,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        created_at,
        empresa:empresas(id,nome,endereco_resumo,gestor_id),
        gestor:gestores(id,nome)
      `
      )
      .eq("id", quadraId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Quadra não encontrada." });

    return res.json(data);
  } catch (err) {
    console.error("[ADMIN/QUADRAS][GET/:id] Erro:", err);
    return res.status(500).json({ error: "Erro interno ao buscar quadra (admin)." });
  }
});

// Criar quadra + fotos (form-data)
// POST /admin/quadras
// Campos (form-data):
//  - empresaId (obrigatório)
//  - tipo, material, modalidade (obrigatório)
//  - aviso, informacoes, status (opcionais)
//  - taxa_plataforma_override (opcional)
//  - foto1, foto2, foto3 (opcionais)
app.post(
  "/admin/quadras",
  authPainel,
  permitirTipos("ADMIN"),
  upload.fields([
    { name: "foto1", maxCount: 1 },
    { name: "foto2", maxCount: 1 },
    { name: "foto3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel.id;

      const {
        empresaId,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
        taxa_plataforma_override,
      } = req.body || {};

      if (!empresaId || !tipo || !material || !modalidade) {
        return res.status(400).json({
          error: "Campos obrigatórios: empresaId, tipo, material e modalidade.",
        });
      }

      // empresa -> gestor
      const { empresa, error: eMsg, status: eStatus } =
        await adminBuscarEmpresaOuFalhar(empresaId);
      if (!empresa) return res.status(eStatus).json({ error: eMsg });

      // payload quadra
      const payloadQuadra = {
        gestor_id: empresa.gestor_id,
        empresa_id: empresaId,
        tipo,
        material,
        modalidade,
        informacoes: informacoes || null,
        aviso: aviso || null,
        status: status || "ativa",
        taxa_plataforma_override:
          taxa_plataforma_override === "" || taxa_plataforma_override == null
            ? null
            : Number(taxa_plataforma_override),
        url_imagem_header: null,
        url_imagem_2: null,
        url_imagem_3: null,
        desativado_por_tipo: null,
        motivo_desativacao: null,
      };

      const { data: quadra, error: insertError } = await supabase
        .from("quadras")
        .insert([payloadQuadra])
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          taxa_plataforma_override,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .single();

      if (insertError || !quadra) {
        console.error("[ADMIN/QUADRAS][POST] Erro ao criar quadra:", insertError);
        return res.status(500).json({ error: "Erro ao criar quadra (admin)." });
      }

      // Upload fotos (mesma lógica do gestor, mas usando gestor_id inferido)
      const bucketName = "quadras";

      async function processarFoto(formKey, campoDb) {
        const file = req.files?.[formKey]?.[0];
        if (!file) return null;

        const ext = (file.originalname || "").split(".").pop() || "jpg";
        const pathInterno = `${quadra.gestor_id}/${quadra.id}/${campoDb}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(pathInterno, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          console.error(`[ADMIN/QUADRAS][POST] Erro upload ${campoDb}:`, uploadError);
          return null;
        }

        const { data: publicData } = supabase.storage
          .from(bucketName)
          .getPublicUrl(pathInterno);

        return publicData?.publicUrl || null;
      }

      const url1 = await processarFoto("foto1", "url_imagem_header");
      const url2 = await processarFoto("foto2", "url_imagem_2");
      const url3 = await processarFoto("foto3", "url_imagem_3");

      const updates = {};
      if (url1) updates.url_imagem_header = url1;
      if (url2) updates.url_imagem_2 = url2;
      if (url3) updates.url_imagem_3 = url3;

      let quadraFinal = quadra;

      if (Object.keys(updates).length > 0) {
        const { data: quadraAtualizada } = await supabase
          .from("quadras")
          .update(updates)
          .eq("id", quadra.id)
          .select(
            `
            id,
            empresa_id,
            gestor_id,
            tipo,
            material,
            modalidade,
            informacoes,
            aviso,
            status,
            taxa_plataforma_override,
            url_imagem_header,
            url_imagem_2,
            url_imagem_3
          `
          )
          .single();

        if (quadraAtualizada) quadraFinal = quadraAtualizada;
      }

      // log audit (se você já está usando)
      if (typeof logAudit === "function") {
        await logAudit(req, {
          acao: "ADMIN_QUADRA_CRIADA",
          entidade: "quadras",
          entidade_id: quadraFinal.id,
          detalhes: { admin_id: adminId, empresa_id: empresaId },
        });
      }

      return res.status(201).json(quadraFinal);
    } catch (err) {
      console.error("[ADMIN/QUADRAS][POST] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao criar quadra (admin)." });
    }
  }
);

// Editar quadra (sem fotos) — JSON
// PUT /admin/quadras/:id
app.put("/admin/quadras/:id", authPainel, permitirTipos("ADMIN"), async (req, res) => {
  try {
    const quadraId = req.params.id;

    const {
      empresa_id, // pode trocar empresa na edição
      tipo,
      material,
      modalidade,
      informacoes,
      aviso,
      status,
      taxa_plataforma_override,
    } = req.body || {};

    // busca quadra
    const { data: quadraAtual, error: eQ } = await supabase
      .from("quadras")
      .select("id, empresa_id, gestor_id, status")
      .eq("id", quadraId)
      .maybeSingle();

    if (eQ) return res.status(500).json({ error: eQ.message });
    if (!quadraAtual) return res.status(404).json({ error: "Quadra não encontrada." });

    // se mudar empresa, inferir gestor_id novo
    let novoGestorId = quadraAtual.gestor_id;
    let novaEmpresaId = quadraAtual.empresa_id;

    if (empresa_id && empresa_id !== quadraAtual.empresa_id) {
      const { empresa, error: eMsg, status: eStatus } =
        await adminBuscarEmpresaOuFalhar(empresa_id);
      if (!empresa) return res.status(eStatus).json({ error: eMsg });

      novaEmpresaId = empresa_id;
      novoGestorId = empresa.gestor_id;
    }

    const updatePayload = {
      empresa_id: novaEmpresaId,
      gestor_id: novoGestorId,
      tipo: tipo ?? null,
      material: material ?? null,
      modalidade: modalidade ?? null,
      informacoes: informacoes ?? null,
      aviso: aviso ?? null,
      status: status ?? quadraAtual.status ?? "ativa",
      taxa_plataforma_override:
        taxa_plataforma_override === "" || taxa_plataforma_override == null
          ? null
          : Number(taxa_plataforma_override),
    };

    const { data, error } = await supabase
      .from("quadras")
      .update(updatePayload)
      .eq("id", quadraId)
      .select(
        `
        id,
        empresa_id,
        gestor_id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
        desativado_por_tipo,
        motivo_desativacao,
        taxa_plataforma_override,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3
      `
      )
      .single();

    if (error) return res.status(500).json({ error: error.message });

    if (typeof logAudit === "function") {
      await logAudit(req, {
        acao: "ADMIN_QUADRA_EDITADA",
        entidade: "quadras",
        entidade_id: quadraId,
        detalhes: { empresa_id: data.empresa_id },
      });
    }

    return res.json(data);
  } catch (err) {
    console.error("[ADMIN/QUADRAS][PUT] Erro:", err);
    return res.status(500).json({ error: "Erro interno ao editar quadra (admin)." });
  }
});

// Editar fotos
// PUT /admin/quadras/:id/fotos  (form-data com foto1/foto2/foto3)
app.put(
  "/admin/quadras/:id/fotos",
  authPainel,
  permitirTipos("ADMIN"),
  upload.fields([
    { name: "foto1", maxCount: 1 },
    { name: "foto2", maxCount: 1 },
    { name: "foto3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const quadraId = req.params.id;

      const { data: quadra, error: eQ } = await supabase
        .from("quadras")
        .select("id, gestor_id")
        .eq("id", quadraId)
        .maybeSingle();

      if (eQ) return res.status(500).json({ error: eQ.message });
      if (!quadra) return res.status(404).json({ error: "Quadra não encontrada." });

      const bucketName = "quadras";

      async function processarFoto(formKey, campoDb) {
        const file = req.files?.[formKey]?.[0];
        if (!file) return null;

        const ext = (file.originalname || "").split(".").pop() || "jpg";
        const pathInterno = `${quadra.gestor_id}/${quadra.id}/${campoDb}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(pathInterno, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          console.error(`[ADMIN/QUADRAS][FOTOS] Erro upload ${campoDb}:`, uploadError);
          return null;
        }

        const { data: publicData } = supabase.storage
          .from(bucketName)
          .getPublicUrl(pathInterno);

        return publicData?.publicUrl || null;
      }

      const url1 = await processarFoto("foto1", "url_imagem_header");
      const url2 = await processarFoto("foto2", "url_imagem_2");
      const url3 = await processarFoto("foto3", "url_imagem_3");

      const updates = {};
      if (url1) updates.url_imagem_header = url1;
      if (url2) updates.url_imagem_2 = url2;
      if (url3) updates.url_imagem_3 = url3;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "Nenhuma foto enviada." });
      }

      const { data: quadraAtualizada, error: eU } = await supabase
        .from("quadras")
        .update(updates)
        .eq("id", quadraId)
        .select(
          `
          id,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .single();

      if (eU) return res.status(500).json({ error: eU.message });

      return res.json(quadraAtualizada);
    } catch (err) {
      console.error("[ADMIN/QUADRAS][FOTOS] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao atualizar fotos (admin)." });
    }
  }
);

// Desativar (admin)
// PATCH /admin/quadras/:id/desativar  body opcional: { motivo }
app.patch(
  "/admin/quadras/:id/desativar",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const quadraId = req.params.id;
      const { motivo } = req.body || {};

      const { data, error } = await supabase
        .from("quadras")
        .update({
          status: "inativa",
          desativado_por_tipo: "ADMIN",
          motivo_desativacao: motivo || "Bloqueada pelo administrador",
        })
        .eq("id", quadraId)
        .select(
          `
          id,
          status,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/QUADRAS][DESATIVAR] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao desativar quadra (admin)." });
    }
  }
);

// Reativar (admin)
// PATCH /admin/quadras/:id/reativar
app.patch(
  "/admin/quadras/:id/reativar",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const quadraId = req.params.id;

      const { data, error } = await supabase
        .from("quadras")
        .update({
          status: "ativa",
          desativado_por_tipo: null,
          motivo_desativacao: null,
        })
        .eq("id", quadraId)
        .select(
          `
          id,
          status,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      console.error("[ADMIN/QUADRAS][REATIVAR] Erro:", err);
      return res.status(500).json({ error: "Erro interno ao reativar quadra (admin)." });
    }
  }
);

// Soft delete (admin)
// DELETE /admin/quadras/:id  -> marca status='excluida' e registra motivo
app.delete("/admin/quadras/:id", authPainel, permitirTipos("ADMIN"), async (req, res) => {
  try {
    const quadraId = req.params.id;

    const { data, error } = await supabase
      .from("quadras")
      .update({
        status: "excluida",
        desativado_por_tipo: "ADMIN",
        motivo_desativacao: "Excluída (soft delete) pelo administrador",
      })
      .eq("id", quadraId)
      .select("id, status, desativado_por_tipo, motivo_desativacao")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json(data);
  } catch (err) {
    console.error("[ADMIN/QUADRAS][DELETE] Erro:", err);
    return res.status(500).json({ error: "Erro interno ao excluir quadra (admin)." });
  }
});

// ======================================
// ROTAS GESTOR - QUADRAS
// ======================================
// -----------------------------------------
// POST /gestor/quadras  → cria quadra + fotos
// Campos (form-data):
//  - complexoId (id da empresa/complexo)
//  - tipo, material, modalidade, aviso, informacoes, status
//  - foto1, foto2, foto3 (opcionais)
// -----------------------------------------
app.post(
  "/gestor/quadras",
  authPainel,
  permitirTipos("GESTOR"),
  upload.fields([
    { name: "foto1", maxCount: 1 },
    { name: "foto2", maxCount: 1 },
    { name: "foto3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;

      // Campos de texto vindos do form-data
      const {
        complexoId,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
      } = req.body || {};

      if (!complexoId || !tipo || !material || !modalidade) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: complexoId, tipo, material e modalidade.",
        });
      }

      // 1) Garante que o complexo pertence ao gestor logado
      const { data: empresa, error: errorEmpresa } = await supabase
        .from("empresas")
        .select("id, gestor_id, ativo")
        .eq("id", complexoId)
        .eq("gestor_id", gestorId)
        .maybeSingle();

      if (errorEmpresa || !empresa) {
        console.error(
          "[GESTOR/QUADRAS][POST] Empresa não encontrada ou não pertence ao gestor:",
          errorEmpresa
        );
        return res
          .status(404)
          .json({ error: "Complexo não encontrado para este gestor." });
      }

      if (empresa.ativo === false) {
        return res.status(400).json({
          error:
            "Não é possível cadastrar quadra em um complexo desativado. Reative o complexo primeiro.",
        });
      }

      // 2) Cria a quadra sem as URLs das imagens
      const payloadQuadra = {
        gestor_id: gestorId,
        empresa_id: complexoId,
        tipo,
        material,
        modalidade,
        informacoes: informacoes || null,
        aviso: aviso || null,
        status: status || "ativa",
        url_imagem_header: null,
        url_imagem_2: null,
        url_imagem_3: null,
      };

      const { data: quadra, error: insertError } = await supabase
        .from("quadras")
        .insert([payloadQuadra])
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .single();

      if (insertError || !quadra) {
        console.error("[GESTOR/QUADRAS][POST] Erro ao criar quadra:", insertError);
        return res.status(500).json({
          error: "Erro ao criar quadra em /gestor/quadras.",
          supabase: insertError,
        });
      }

      const quadraId = quadra.id;

      // 3) Se existirem fotos, faz upload para o Storage
      const arquivos = req.files || {};
      const bucketName = "quadras";

      async function processarFoto(campo, colunaDestino) {
        const arr = arquivos[campo];
        if (!arr || !arr[0]) return null;

        const file = arr[0];
        const ext = file.originalname.split(".").pop() || "jpg";
        const pathInterno = `${gestorId}/${quadraId}/${campo}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(pathInterno, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) {
          console.error(
            `[GESTOR/QUADRAS][POST] Erro ao fazer upload de ${campo}:`,
            uploadError
          );
          return null;
        }

        const { data: publicData } = supabase.storage
          .from(bucketName)
          .getPublicUrl(pathInterno);

        return publicData?.publicUrl || null;
      }

      const url1 = await processarFoto("foto1", "url_imagem_header");
      const url2 = await processarFoto("foto2", "url_imagem_2");
      const url3 = await processarFoto("foto3", "url_imagem_3");

      const updates = {};
      if (url1) updates.url_imagem_header = url1;
      if (url2) updates.url_imagem_2 = url2;
      if (url3) updates.url_imagem_3 = url3;

      let quadraFinal = quadra;

      if (Object.keys(updates).length > 0) {
        const { data: quadraAtualizada, error: updateError } = await supabase
          .from("quadras")
          .update(updates)
          .eq("id", quadraId)
          .select(
            `
            id,
            empresa_id,
            gestor_id,
            tipo,
            material,
            modalidade,
            informacoes,
            aviso,
            status,
            url_imagem_header,
            url_imagem_2,
            url_imagem_3
          `
          )
          .single();

        if (updateError) {
          console.error(
            "[GESTOR/QUADRAS][POST] Erro ao atualizar URLs de imagem da quadra:",
            updateError
          );
        } else {
          quadraFinal = quadraAtualizada;
        }
      }

      console.log(
        "[GESTOR/QUADRAS][POST] Quadra criada com sucesso:",
        quadraFinal.id
      );
      return res.status(201).json(quadraFinal);
    } catch (err) {
      console.error("[GESTOR/QUADRAS][POST] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao criar quadra." });
    }
  }
);

// Lista quadras do gestor logado (opcional: filtrar por empresa_id)
app.get(
  "/gestor/quadras",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { empresaId } = req.query;

      let query = supabase
        .from("quadras")
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .eq("gestor_id", gestorId)
        .order("tipo", { ascending: true })
        .order("material", { ascending: true })
        .order("modalidade", { ascending: true });

      if (empresaId) {
        query = query.eq("empresa_id", empresaId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("[GESTOR/QUADRAS] Erro ao buscar quadras:", error);
        return res
          .status(500)
          .json({ error: "Erro ao buscar quadras do gestor." });
      }

      return res.json(data || []);
    } catch (err) {
      console.error("[GESTOR/QUADRAS] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao buscar quadras." });
    }
  }
);

// Detalhes de uma quadra específica do gestor (para edição)
app.get(
  "/gestor/quadras/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.params.id;

      const { data, error } = await supabase
        .from("quadras")
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .single();

      if (error || !data) {
        console.error("[GESTOR/QUADRAS] Erro ao buscar quadra:", error);
        return res
          .status(404)
          .json({ error: "Quadra não encontrada para este gestor." });
      }

      return res.json(data);
    } catch (err) {
      console.error("[GESTOR/QUADRAS] Erro inesperado ao buscar quadra:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao buscar quadra." });
    }
  }
);

// [ARQUIVO: index.js - Cole isso onde ficava a rota antiga problemática]

// -----------------------------------------
// PUT /gestor/quadras/:id
// Atualiza APENAS os campos de texto da quadra
// (tipo, material, modalidade, informacoes, aviso, status)
// NÃO MEXE em nenhuma coluna de imagem
// -----------------------------------------
app.put(
  "/gestor/quadras/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.params.id;

      const {
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
        // ⚠️ NÃO usamos url_imagem_header, url_imagem_2, url_imagem_3 aqui
        // ⚠️ NÃO usamos empresa_id aqui (pra simplificar e evitar efeito colateral)
      } = req.body || {};

      // Monta payload só com campos presentes (não-undefined)
      const camposPossiveis = {
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status,
      };

      const payloadUpdate = {};
      for (const [chave, valor] of Object.entries(camposPossiveis)) {
        if (typeof valor !== "undefined") {
          payloadUpdate[chave] = valor;
        }
      }

      // Se nada veio pra atualizar, retorna erro amigável
      if (Object.keys(payloadUpdate).length === 0) {
        return res.status(400).json({
          error:
            "Nenhum campo válido para atualizar. Envie tipo, material, modalidade, informacoes, aviso ou status.",
        });
      }

      // Garante que a quadra é do gestor logado
      const { data: quadraExistente, error: erroBusca } = await supabase
        .from("quadras")
        .select("id, gestor_id")
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .single();

      if (erroBusca || !quadraExistente) {
        console.error(
          "[GESTOR/QUADRAS][PUT] Quadra não encontrada para este gestor:",
          erroBusca
        );
        return res
          .status(404)
          .json({ error: "Quadra não encontrada para este gestor." });
      }

      // Faz o UPDATE só com os campos de texto
      const { data, error: erroUpdate } = await supabase
        .from("quadras")
        .update(payloadUpdate)
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .single();

      if (erroUpdate || !data) {
        console.error(
          "[GESTOR/QUADRAS][PUT] Erro ao atualizar quadra:",
          erroUpdate
        );
        return res
          .status(500)
          .json({ error: "Erro ao atualizar quadra do gestor." });
      }

      console.log(
        "[GESTOR/QUADRAS][PUT] Quadra atualizada com sucesso (apenas texto):",
        data.id
      );
      return res.json(data);
    } catch (err) {
      console.error("[GESTOR/QUADRAS][PUT] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao atualizar quadra." });
    }
  }
);
// GESTOR desativa uma quadra (soft delete via status)
app.patch(
  "/gestor/quadras/:id/desativar",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.params.id;
      const { motivo } = req.body || {};

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/quadras/:id/desativar (PATCH).",
        });
      }

      // Garante que a quadra pertence ao gestor
      const { data: quadra, error: errorQuadra } = await supabase
        .from("quadras")
        .select("id, gestor_id, status")
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .single();

      if (errorQuadra || !quadra) {
        console.error(
          "[GESTOR/QUADRAS][DESATIVAR] Quadra não encontrada para este gestor:",
          errorQuadra
        );
        return res.status(404).json({
          error: "Quadra não encontrada para este gestor.",
        });
      }

      const { data, error } = await supabase
        .from("quadras")
        .update({
          status: "inativa",
          desativado_por_tipo: "GESTOR",
          motivo_desativacao:
            typeof motivo === "string" && motivo.trim().length > 0
              ? motivo.trim()
              : "Desativada pelo gestor.",
        })
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          status,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error || !data) {
        console.error(
          "[GESTOR/QUADRAS][DESATIVAR] Erro ao atualizar quadra:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao desativar quadra (gestor)." });
      }

      return res.json(data);
    } catch (err) {
      console.error(
        "[GESTOR/QUADRAS][DESATIVAR] Erro inesperado:",
        err
      );
      return res
        .status(500)
        .json({ error: "Erro interno ao desativar quadra do gestor." });
    }
  }
);

// GESTOR reativa uma quadra (desde que não tenha sido bloqueada pelo ADMIN)
app.patch(
  "/gestor/quadras/:id/reativar",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.params.id;

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/quadras/:id/reativar (PATCH).",
        });
      }

      // Busca quadra e garante que pertence ao gestor
      const { data: quadra, error: errorQuadra } = await supabase
        .from("quadras")
        .select(
          `
          id,
          gestor_id,
          status,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .single();

      if (errorQuadra || !quadra) {
        console.error(
          "[GESTOR/QUADRAS][REATIVAR] Quadra não encontrada:",
          errorQuadra
        );
        return res.status(404).json({
          error: "Quadra não encontrada para este gestor.",
        });
      }

      // Se ADMIN bloqueou, gestor não reativa
      if (quadra.desativado_por_tipo === "ADMIN") {
        return res.status(403).json({
          error:
            "Esta quadra foi bloqueada pelo administrador da plataforma. Fale com o suporte.",
        });
      }

      const { data, error } = await supabase
        .from("quadras")
        .update({
          status: "ativa",
          desativado_por_tipo: null,
          motivo_desativacao: null,
        })
        .eq("id", quadraId)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          status,
          desativado_por_tipo,
          motivo_desativacao
        `
        )
        .single();

      if (error) {
        console.error(
          "[GESTOR/QUADRAS][REATIVAR] Erro ao reativar quadra:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao reativar quadra (gestor)." });
      }

      return res.json(data);
    } catch (err) {
      console.error(
        "[GESTOR/QUADRAS][REATIVAR] Erro inesperado:",
        err
      );
      return res
        .status(500)
        .json({ error: "Erro interno ao reativar quadra do gestor." });
    }
  }
);

// Remove uma quadra do gestor logado
app.delete(
  "/gestor/quadras/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.params.id;

      const { error } = await supabase
        .from("quadras")
        .delete()
        .eq("id", quadraId)
        .eq("gestor_id", gestorId);

      if (error) {
        console.error("[GESTOR/QUADRAS] Erro ao excluir quadra:", error);
        return res
          .status(500)
          .json({ error: "Erro ao excluir quadra." });
      }

      return res.status(204).send();
    } catch (err) {
      console.error("[GESTOR/QUADRAS] Erro inesperado ao excluir quadra:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao excluir quadra." });
    }
  }
);
// -----------------------------------------
// ROTAS AGENDA – GESTOR
// Tabelas:
// - regras_horarios: id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor, created_at
// - bloqueios_quadra: id, quadra_id, data, hora_inicio, hora_fim, motivo, created_at
//
// OBS IMPORTANTES:
// - No BANCO é id_quadra / dia_da_semana / valor.
// - Na API eu devolvo como quadra_id / dia_semana / preco_hora
//   para casar com o frontend GestorAgendaPage.
// - Campo "ativo" NÃO existe na tabela; eu devolvo sempre ativo: true no JSON.
// -----------------------------------------

// Função auxiliar: verifica se a quadra pertence ao gestor
async function validarQuadraDoGestor(quadraId, gestorId) {
  const { data: quadra, error } = await supabase
    .from("quadras")
    .select("id, gestor_id")
    .eq("id", quadraId)
    .single();

  if (error) {
    console.error("[AGENDA] Erro ao buscar quadra em validarQuadraDoGestor:", error);
    throw new Error("Erro ao validar quadra");
  }

  if (!quadra) {
    throw new Error("Quadra não encontrada");
  }

  if (quadra.gestor_id !== gestorId) {
    throw new Error("Quadra não pertence a este gestor");
  }

  return quadra;
}
// Função auxiliar: gera slots de 1h (10:00–11:00, 11:00–12:00, etc.)
function gerarSlotsHoraCheia(horaInicio, horaFim) {
  function parseHoraParaMinutos(hora) {
    if (typeof hora !== "string") {
      throw new Error("Hora inválida (não é string).");
    }

    const partes = hora.split(":");
    const horas = Number(partes[0]);
    const minutos = partes[1] !== undefined ? Number(partes[1]) : 0;

    if (
      !Number.isInteger(horas) ||
      !Number.isInteger(minutos) ||
      horas < 0 ||
      horas > 23 ||
      minutos < 0 ||
      minutos > 59
    ) {
      throw new Error(`Hora inválida: ${hora}. Use formato HH:MM, ex: 10:00.`);
    }

    return horas * 60 + minutos;
  }

  function formatarMinutosParaHora(totalMinutos) {
    const h = Math.floor(totalMinutos / 60);
    const m = totalMinutos % 60;
    const hh = String(h).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const inicioMin = parseHoraParaMinutos(horaInicio);
  const fimMin = parseHoraParaMinutos(horaFim);

  if (inicioMin >= fimMin) {
    throw new Error("horaInicio deve ser menor que horaFim.");
  }

  const intervalo = fimMin - inicioMin;

  // Só aceitamos intervalos múltiplos de 1h (60 minutos)
  if (intervalo % 60 !== 0) {
    throw new Error(
      "Intervalo de horário inválido. Use apenas horários cheios (ex: 10:00 até 18:00)."
    );
  }

  const slots = [];
  for (let t = inicioMin; t < fimMin; t += 60) {
    const inicioSlot = formatarMinutosParaHora(t);
    const fimSlot = formatarMinutosParaHora(t + 60);
    slots.push({
      hora_inicio: inicioSlot,
      hora_fim: fimSlot,
    });
  }

  return slots;
}

// -----------------------------------------
// REGRAS DE HORÁRIO
// -----------------------------------------

/**
 * Gera slots de hora cheia entre dois horários.
 * Exemplo: "10:00" -> "18:00"  ===>
 *  [ ["10:00","11:00"], ["11:00","12:00"], ... , ["17:00","18:00"] ]
 *
 * O horário final é EXCLUSIVO: 10–18 gera 8 slots de 1h.
 */
function gerarSlotsHoraCheia(horaInicio, horaFim) {
  const parse = (str) => {
    const [h, m] = String(str).split(":").map(Number);
    return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
  };

  const inicio = parse(horaInicio);
  const fim = parse(horaFim);

  const inicioMin = inicio.h * 60 + inicio.m;
  const fimMin = fim.h * 60 + fim.m;

  if (fimMin <= inicioMin) {
    throw new Error("horaInicio deve ser menor que horaFim para geração de slots.");
  }

  const slots = [];
  for (let t = inicioMin; t < fimMin; t += 60) {
    const hIni = Math.floor(t / 60);
    const mIni = t % 60;
    const hFim = Math.floor((t + 60) / 60);
    const mFim = (t + 60) % 60;

    if (t + 60 > fimMin) break; // garante que não cria slot que ultrapassa horaFim

    const fmt = (h, m) =>
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    slots.push({
      hora_inicio: fmt(hIni, mIni),
      hora_fim: fmt(hFim, mFim),
    });
  }

  return slots;
}

// GET /gestor/agenda/regras
// Lista regras de horário de uma quadra do gestor logado
app.get(
  "/gestor/agenda/regras",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId } = req.query;

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /gestor/agenda/regras.",
        });
      }

      await validarQuadraDoGestor(quadraId, gestorId);

      const { data, error } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor,
          created_at
        `
        )
        .eq("id_quadra", quadraId)
        .order("dia_da_semana", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (error) {
        console.error("[AGENDA/REGRAS][GET] Erro ao buscar regras_horarios:", error);
        return res
          .status(500)
          .json({ error: "Erro ao buscar regras de horário" });
      }

      const regras = (data || []).map((r) => ({
        id: r.id,
        quadra_id: r.id_quadra,
        dia_semana: r.dia_da_semana,
        hora_inicio: r.hora_inicio,
        hora_fim: r.hora_fim,
        preco_hora: r.valor,
        ativo: true,
        created_at: r.created_at,
      }));

      return res.json({ regras });
    } catch (err) {
      console.error("[AGENDA/REGRAS][GET] Erro geral:", err.message);
      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao listar regras de horário." });
    }
  }
);

// POST /gestor/agenda/regras/lote
// Cria regras em lote, EXPANDINDO o intervalo em horários cheios (ex.: 10–18 => 10–11, 11–12, ..., 17–18)
//
// Body esperado:
// {
//   "quadraIds": ["idQuadraA","idQuadraB",...],
//   "diasSemana": [1,2,3,4,5],          // 0 = Domingo ... 6 = Sábado
//   "horaInicio": "10:00",              // inclusivo
//   "horaFim": "18:00",                 // exclusivo (limite superior)
//   "precoHora": 100.0,
//   "ativo": true
// }
app.post(
  "/gestor/agenda/regras/lote",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const {
        quadraIds,
        diasSemana,
        horaInicio,
        horaFim,
        precoHora,
        ativo = true, // não existe no banco, só semântica de API
      } = req.body || {};

      if (!Array.isArray(quadraIds) || quadraIds.length === 0) {
        return res.status(400).json({
          error:
            "Informe pelo menos uma quadra em quadraIds para criar regras em lote.",
        });
      }

      if (!Array.isArray(diasSemana) || diasSemana.length === 0) {
        return res.status(400).json({
          error:
            "Informe pelo menos um dia da semana em diasSemana (0=Domingo ... 6=Sábado).",
        });
      }

      if (!horaInicio || !horaFim) {
        return res
          .status(400)
          .json({ error: "Campos obrigatórios: horaInicio e horaFim." });
      }

      // Converte HH:MM em minutos para validar intervalo e gerar horários cheios
      const parseHoraParaMinutos = (horaStr) => {
        if (!horaStr) return NaN;
        const [hStr, mStr] = String(horaStr).split(":");
        const h = Number(hStr);
        const m = Number(mStr ?? "0");
        if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
        return h * 60 + m;
      };

      const minutosInicio = parseHoraParaMinutos(horaInicio);
      const minutosFim = parseHoraParaMinutos(horaFim);

      if (!Number.isFinite(minutosInicio) || !Number.isFinite(minutosFim)) {
        return res.status(400).json({
          error: "Formato de hora inválido. Use HH:MM (ex.: '10:00').",
        });
      }

      if (minutosInicio >= minutosFim) {
        return res.status(400).json({
          error: "horaInicio deve ser menor que horaFim.",
        });
      }

      // Gera os intervalos de 1h: 10–18 => [10–11, 11–12, ..., 17–18]
      const slots = [];
      for (let min = minutosInicio; min + 60 <= minutosFim; min += 60) {
        const h1 = Math.floor(min / 60);
        const h2 = h1 + 1;
        const hh1 = String(h1).padStart(2, "0");
        const hh2 = String(h2).padStart(2, "0");
        slots.push({
          hora_inicio: `${hh1}:00`,
          hora_fim: `${hh2}:00`,
        });
      }

      if (slots.length === 0) {
        return res.status(400).json({
          error:
            "Intervalo informado não gera nenhum horário cheio. " +
            "Exemplo válido: horaInicio='10:00' e horaFim='18:00'.",
        });
      }

      const precoNormalizado =
        precoHora === "" || precoHora === undefined || precoHora === null
          ? null
          : Number(String(precoHora).replace(",", "."));

      // Confere se TODAS as quadras pertencem ao gestor logado
      const { data: quadrasDoGestor, error: erroQuadras } = await supabase
        .from("quadras")
        .select("id, gestor_id, empresa_id")
        .in("id", quadraIds)
        .eq("gestor_id", gestorId);

      if (erroQuadras) {
        console.error(
          "[AGENDA/REGRAS-LOTE] Erro ao buscar quadras do gestor:",
          erroQuadras
        );
        return res
          .status(500)
          .json({ error: "Erro ao validar quadras do gestor." });
      }

      if (!quadrasDoGestor || quadrasDoGestor.length !== quadraIds.length) {
        return res.status(403).json({
          error:
            "Uma ou mais quadras não pertencem a este gestor (ou não foram encontradas).",
        });
      }

      // Busca TODAS as regras existentes para essas quadras/dias,
      // para detectar conflito de dia+horário (hora cheia)
      const { data: regrasExistentes, error: erroRegrasExistentes } =
        await supabase
          .from("regras_horarios")
          .select("id_quadra, dia_da_semana, hora_inicio, hora_fim")
          .in("id_quadra", quadraIds)
          .in("dia_da_semana", diasSemana);

      if (erroRegrasExistentes) {
        console.error(
          "[AGENDA/REGRAS-LOTE] Erro ao buscar regras existentes:",
          erroRegrasExistentes
        );
        return res
          .status(500)
          .json({ error: "Erro ao verificar regras existentes." });
      }

      // Monta um Set com todas as combinações já existentes
      const chaveRegra = (quadraId, dia, hIni, hFim) =>
        `${quadraId}::${dia}::${hIni}::${hFim}`;

      const existentesSet = new Set(
        (regrasExistentes || []).map((r) =>
          chaveRegra(r.id_quadra, r.dia_da_semana, r.hora_inicio, r.hora_fim)
        )
      );

      const inserts = [];
      const conflitos = [];

      for (const quadraId of quadraIds) {
        for (const dia of diasSemana) {
          for (const slot of slots) {
            const chave = chaveRegra(
              quadraId,
              dia,
              slot.hora_inicio,
              slot.hora_fim
            );

            if (existentesSet.has(chave)) {
              conflitos.push({
                quadra_id: quadraId,
                dia_semana: dia,
                hora_inicio: slot.hora_inicio,
                hora_fim: slot.hora_fim,
              });
              continue;
            }

            inserts.push({
              id_quadra: quadraId,
              dia_da_semana: dia,
              hora_inicio: slot.hora_inicio,
              hora_fim: slot.hora_fim,
              valor: precoNormalizado,
            });
          }
        }
      }

      // Se houver qualquer conflito, NÃO insere nada e orienta a usar a edição
      if (conflitos.length > 0) {
        return res.status(409).json({
          error:
            "Já existem regras para alguns desses dias/horários. " +
            "Use a tela de edição para alterar preço ou horário.",
          conflitos,
        });
      }

      if (inserts.length === 0) {
        return res.status(400).json({
          error:
            "Esses dias e horários já estão cadastrados para as quadras selecionadas. Nada novo foi criado.",
        });
      }

      const { data: regrasCriadasRaw, error: erroInsert } = await supabase
        .from("regras_horarios")
        .insert(inserts)
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor,
          created_at
        `
        );

      if (erroInsert) {
        console.error(
          "[AGENDA/REGRAS-LOTE] Erro ao criar regras em lote:",
          erroInsert
        );

        // 🔴 Tratamento específico para erro 23505 (unique constraint)
        if (erroInsert.code === "23505") {
          return res.status(409).json({
            error:
              "Já existem regras para alguns desses dias/horários (chave única). " +
              "Use a tela de edição para alterar preço ou horário.",
          });
        }

        return res
          .status(500)
          .json({ error: "Erro ao criar regras de horário em lote." });
      }

      const regrasCriadas = (regrasCriadasRaw || []).map((r) => ({
        id: r.id,
        quadra_id: r.id_quadra,
        dia_semana: r.dia_da_semana,
        hora_inicio: r.hora_inicio,
        hora_fim: r.hora_fim,
        preco_hora: r.valor,
        ativo: true,
        created_at: r.created_at,
      }));

      return res.status(201).json({
        message: "Regras criadas em lote com sucesso (horários cheios).",
        regras: regrasCriadas,
      });
    } catch (err) {
      console.error("[AGENDA/REGRAS-LOTE] Erro geral:", err);

      if (err.code === "23505") {
        // fallback se o erro escapar do bloco do insert
        return res.status(409).json({
          error:
            "Já existem regras para alguns desses dias/horários (chave única). " +
            "Use a tela de edição para alterar preço ou horário.",
        });
      }

      return res
        .status(500)
        .json({ error: "Erro interno ao criar regras de horário em lote." });
    }
  }
);

// POST /gestor/agenda/regras
// Cria VÁRIAS regras de horário de 1h (10–11, 11–12, ..., 17–18) para UMA quadra e UM dia
// Body esperado:
// {
//   "quadraId": "uuid-da-quadra",
//   "diaSemana": 1, // 0 a 6 ou 1 a 7, conforme seu padrão atual
//   "horaInicio": "10:00",
//   "horaFim": "18:00",
//   "precoHora": 100.0,
//   "ativo": true   // ignorado no banco
// }
app.post(
  "/gestor/agenda/regras",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const {
        quadraId,
        diaSemana,
        horaInicio,
        horaFim,
        precoHora,
        ativo = true, // ignorado no banco, sempre tratamos como ativo
      } = req.body || {};

      if (!quadraId || diaSemana === undefined || !horaInicio || !horaFim) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: quadraId, diaSemana, horaInicio, horaFim.",
        });
      }

      // Garante que a quadra pertence a este gestor
      await validarQuadraDoGestor(quadraId, gestorId);

      // Gera slots de 1h (10–11, 11–12, ..., 17–18)
      let slots;
      try {
        slots = gerarSlotsHoraCheia(horaInicio, horaFim);
      } catch (e) {
        // Erros de validação de horário (formato, intervalo, etc.)
        return res.status(400).json({ error: e.message });
      }

      const precoNormalizado =
        precoHora === "" || precoHora === undefined || precoHora === null
          ? null
          : Number(String(precoHora).replace(",", "."));

      // Verifica se já existem horários nesse intervalo para esta quadra/dia
      const horaInicioMenor = slots[0].hora_inicio;
      const horaFimMaior = slots[slots.length - 1].hora_fim;

      const { data: existentes, error: erroExistentes } = await supabase
        .from("regras_horarios")
        .select("id, hora_inicio, hora_fim")
        .eq("id_quadra", quadraId)
        .eq("dia_da_semana", diaSemana)
        .gte("hora_inicio", horaInicioMenor)
        .lt("hora_inicio", horaFimMaior);

      if (erroExistentes) {
        console.error(
          "[AGENDA/REGRAS][POST] Erro ao buscar regras existentes:",
          erroExistentes
        );
        return res.status(500).json({
          error: "Erro ao verificar horários já cadastrados para esta quadra.",
        });
      }

      if (existentes && existentes.length > 0) {
        const conflitosStr = existentes
          .map((r) => `${r.hora_inicio}–${r.hora_fim}`)
          .join(", ");

        return res.status(409).json({
          error:
            "Já existe(m) horário(s) cadastrado(s) para este dia e quadra " +
            `no intervalo informado: ${conflitosStr}. ` +
            "Use a tela de edição para ajustar esses horários.",
        });
      }

      // Monta inserts de 1h cada
      const inserts = slots.map((slot) => ({
        id_quadra: quadraId,
        dia_da_semana: diaSemana,
        hora_inicio: slot.hora_inicio,
        hora_fim: slot.hora_fim,
        valor: precoNormalizado,
      }));

      const { data, error } = await supabase
        .from("regras_horarios")
        .insert(inserts)
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor,
          created_at
        `
        )
        .order("dia_da_semana", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (error) {
        console.error("[AGENDA/REGRAS][POST] Erro ao inserir regras:", error);

        // 🔴 Tratamento específico do erro 23505 (chave única duplicada)
        if (error.code === "23505") {
          return res.status(409).json({
            error:
              "Já existe regra de horário para esse dia/horário. Use a tela de edição para alterar ou excluir.",
          });
        }

        return res
          .status(500)
          .json({ error: "Erro ao criar regras de horário." });
      }

      // Adapta para o frontend (mantendo compatibilidade com 'regra' + 'regras')
      const regras = (data || []).map((r) => ({
        id: r.id,
        quadra_id: r.id_quadra,
        dia_semana: r.dia_da_semana,
        hora_inicio: r.hora_inicio,
        hora_fim: r.hora_fim,
        preco_hora: r.valor,
        ativo: true,
        created_at: r.created_at,
      }));

      // regra = primeira (para não quebrar quem usa um único objeto)
      const regra = regras[0] || null;

      return res.status(201).json({ regra, regras });
    } catch (err) {
      console.error("[AGENDA/REGRAS][POST] Erro geral:", err.message);

      if (err.code === "23505") {
        // fallback, se por algum motivo o erro "vazar" pro catch externo
        return res.status(409).json({
          error:
            "Já existe regra de horário para esse dia/horário. Use a tela de edição para alterar ou excluir.",
        });
      }

      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao criar regra de horário." });
    }
  }
);




// PUT /gestor/agenda/regras/:id
// Edição de uma regra (alterar hora e/ou valor)
app.put(
  "/gestor/agenda/regras/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const regraId = req.params.id;
      const {
        quadraId,
        diaSemana,
        horaInicio,
        horaFim,
        precoHora,
      } = req.body || {};

      if (!regraId || !quadraId) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: id da regra na URL e quadraId no body em /gestor/agenda/regras/:id.",
        });
      }

      if (diaSemana === undefined || diaSemana === null) {
        return res.status(400).json({
          error: "Campo diaSemana é obrigatório para edição.",
        });
      }

      if (!horaInicio || !horaFim) {
        return res.status(400).json({
          error: "Campos obrigatórios: horaInicio e horaFim.",
        });
      }

      await validarQuadraDoGestor(quadraId, gestorId);

      const precoNormalizado =
        precoHora === "" || precoHora === undefined || precoHora === null
          ? null
          : Number(String(precoHora).replace(",", "."));

      const { data, error } = await supabase
        .from("regras_horarios")
        .update({
          id_quadra: quadraId,
          dia_da_semana: diaSemana,
          hora_inicio: horaInicio,
          hora_fim: horaFim,
          valor: precoNormalizado,
        })
        .eq("id", regraId)
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor,
          created_at
        `
        )
        .single();

      if (error) {
        console.error("[AGENDA/REGRAS][PUT] Erro ao atualizar regra:", error);
        // Trata possível violação de UNIQUE (dia/horário já existe em outra regra)
        if (error.code === "23505") {
          return res.status(409).json({
            error:
              "Já existe outra regra com este dia/horário. Ajuste ou exclua a regra duplicada.",
          });
        }
        return res
          .status(500)
          .json({ error: "Erro ao atualizar regra de horário." });
      }

      if (!data) {
        return res
          .status(404)
          .json({ error: "Regra de horário não encontrada para este id." });
      }

      return res.json({
        id: data.id,
        quadra_id: data.id_quadra,
        dia_semana: data.dia_da_semana,
        hora_inicio: data.hora_inicio,
        hora_fim: data.hora_fim,
        preco_hora: data.valor,
        ativo: true,
        created_at: data.created_at,
      });
    } catch (err) {
      console.error("[AGENDA/REGRAS][PUT] Erro geral:", err);
      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao atualizar regra de horário." });
    }
  }
);

// DELETE /gestor/agenda/regras/:id
// Remove uma regra de horário específica (hard delete usando apenas o ID)
app.delete(
  "/gestor/agenda/regras/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const regraId = req.params.id;

      if (!regraId) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/agenda/regras/:id.",
        });
      }

      // Busca a regra para descobrir a quadra e validar a posse
      const { data: regra, error: erroBusca } = await supabase
        .from("regras_horarios")
        .select("id, id_quadra")
        .eq("id", regraId)
        .single();

      if (erroBusca) {
        console.error(
          "[AGENDA/REGRAS][DELETE] Erro ao buscar regra:",
          erroBusca
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar regra antes de excluir." });
      }

      if (!regra) {
        return res
          .status(404)
          .json({ error: "Regra de horário não encontrada." });
      }

      await validarQuadraDoGestor(regra.id_quadra, gestorId);

      const { error: erroDelete } = await supabase
        .from("regras_horarios")
        .delete()
        .eq("id", regraId);

      if (erroDelete) {
        console.error(
          "[AGENDA/REGRAS][DELETE] Erro ao excluir regra:",
          erroDelete
        );
        return res
          .status(500)
          .json({ error: "Erro interno ao excluir regra de horário." });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[AGENDA/REGRAS][DELETE] Erro geral:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao excluir regra de horário." });
    }
  }
);


// BLOQUEIOS
// -----------------------------------------
// Bloqueios são SEMPRE por DATA específica (ex: 2025-12-24) e faixa de horário.
// Diferente das regras (que são recorrentes por dia_da_semana).

// GET /gestor/agenda/bloqueios
// Lista bloqueios manuais de uma quadra do gestor logado
app.get(
  "/gestor/agenda/bloqueios",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId } = req.query;

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /gestor/agenda/bloqueios.",
        });
      }

      await validarQuadraDoGestor(quadraId, gestorId);

      const { data, error } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo,
          created_at
        `
        )
        .eq("quadra_id", quadraId)
        .order("data", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (error) {
        console.error(
          "[AGENDA/BLOQUEIOS][GET] Erro ao buscar bloqueios:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueios da quadra" });
      }

      return res.json({ bloqueios: data || [] });
    } catch (err) {
      console.error("[AGENDA/BLOQUEIOS][GET] Erro geral:", err);
      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao listar bloqueios da quadra." });
    }
  }
);

// POST /gestor/agenda/bloqueios
// Cria UM bloqueio manual para uma quadra (data específica)
app.post(
  "/gestor/agenda/bloqueios",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId, data, horaInicio, horaFim, motivo } = req.body || {};

      if (!quadraId || !data || !horaInicio || !horaFim) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: quadraId, data, horaInicio e horaFim em /gestor/agenda/bloqueios.",
        });
      }

      await validarQuadraDoGestor(quadraId, gestorId);

      const { data: created, error } = await supabase
        .from("bloqueios_quadra")
        .insert({
          quadra_id: quadraId,
          data,
          hora_inicio: horaInicio,
          hora_fim: horaFim,
          motivo,
          criado_por: gestorId,
        })
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo,
          created_at
        `
        )
        .single();

      if (error) {
        console.error(
          "[AGENDA/BLOQUEIOS][POST] Erro ao criar bloqueio:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao criar bloqueio da quadra." });
      }

      return res.status(201).json({ bloqueio: created });
    } catch (err) {
      console.error("[AGENDA/BLOQUEIOS][POST] Erro geral:", err);
      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao criar bloqueio da quadra." });
    }
  }
);
// =========================================
// AGENDA / VISÃO DE SLOTS (PAINEL GESTOR)
// =========================================
// GET /gestor/agenda/slots
// 
// Visão "cinema" para 1 QUADRA:
// - Retorna, para um intervalo de datas, os horários montados a partir de
//   regras_horarios (dia_da_semana + hora_inicio/hora_fim)
// - Marca cada slot como:
//      "DISPONIVEL"  → sem reserva e sem bloqueio
//      "RESERVADO"   → existe reserva pending/paid para data+hora
//      "BLOQUEADO"   → existe bloqueio para data (e faixa de horário)
// 
// Query params:
//   quadraId   (obrigatório)  → UUID da quadra
//   dataInicio (opcional)     → AAAA-MM-DD ou DD/MM/AAAA
//   dataFim    (opcional)     → AAAA-MM-DD ou DD/MM/AAAA
//   filtro     (opcional)     → "disponivel" | "reservada" | "bloqueada" | "todas"
//                                (default: "todas")
// 
// Regra de intervalo:
//   - Se não passar nada, usa HOJE até HOJE+6 (7 dias)
//   - Proteção: máximo de 60 dias por requisição
// 
app.get(
  "/gestor/agenda/slots",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId, dataInicio, dataFim, filtro } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro quadraId é obrigatório em /gestor/agenda/slots.",
        });
      }

      // 1) Garante que a quadra pertence a este Gestor
      await validarQuadraDoGestor(quadraId, gestorId);

      // 2) Monta intervalo de datas
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      let dtInicio = new Date(hoje.getTime());
      let dtFim = new Date(hoje.getTime());
      dtFim.setDate(dtFim.getDate() + 6); // padrão 7 dias (hoje + 6)

      if (dataInicio) {
        const parsed = parseDataAgendamentoBr(dataInicio);
        if (!parsed) {
          return res.status(400).json({
            error:
              "dataInicio inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /gestor/agenda/slots.",
          });
        }
        parsed.setHours(0, 0, 0, 0);
        dtInicio = parsed;
      }

      if (dataFim) {
        const parsed = parseDataAgendamentoBr(dataFim);
        if (!parsed) {
          return res.status(400).json({
            error:
              "dataFim inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /gestor/agenda/slots.",
          });
        }
        parsed.setHours(0, 0, 0, 0);
        dtFim = parsed;
      }

      if (dtFim < dtInicio) {
        return res.status(400).json({
          error: "dataFim não pode ser menor que dataInicio em /gestor/agenda/slots.",
        });
      }

      // Protege contra intervalos muito grandes (máx. 60 dias)
      const diffMs = dtFim.getTime() - dtInicio.getTime();
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDias > 60) {
        return res.status(400).json({
          error:
            "Intervalo máximo permitido é de 60 dias em /gestor/agenda/slots.",
        });
      }

      const dataInicioISO = formatDateISO(dtInicio);
      const dataFimISO = formatDateISO(dtFim);

      // 3) Busca REGRAS de horário da quadra (recorrentes por dia_da_semana)
      const { data: regras, error: errRegras } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor
        `
        )
        .eq("id_quadra", quadraId);

      if (errRegras) {
        console.error("[AGENDA/SLOTS][GET] Erro ao buscar regras_horarios:", errRegras);
        return res
          .status(500)
          .json({ error: "Erro ao buscar regras de horário em /gestor/agenda/slots." });
      }

      const regrasList = regras || [];

      // Mapa por dia_da_semana (0=Domingo ... 6=Sábado)
      const regrasPorDiaSemana = new Map();
      for (const r of regrasList) {
        const key = r.dia_da_semana;
        if (!regrasPorDiaSemana.has(key)) {
          regrasPorDiaSemana.set(key, []);
        }
        regrasPorDiaSemana.get(key).push(r);
      }

      // 4) Busca RESERVAS no período (pending/paid)
      const { data: reservas, error: errReservas } = await supabase
        .from("reservas")
        .select(
          `
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total,
          user_cpf,
          phone
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO)
        .in("status", ["pending", "paid", "pendente", "pago"]);


      if (errReservas) {
        console.error("[AGENDA/SLOTS][GET] Erro ao buscar reservas:", errReservas);
        return res
          .status(500)
          .json({ error: "Erro ao buscar reservas em /gestor/agenda/slots." });
      }

      const reservasList = reservas || [];
        // -----------------------------
  // EXTRA (Admin Dashboard): métricas por quadra + diagnósticos
  // -----------------------------

  // 1) Reservas por quadra (paid/pending/canceled + valores)
  const reservasPorQuadra = new Map();

  for (const r of reservasList) {
    const quadraId = r?.quadra_id || r?.quadras?.id || null;
    if (!quadraId) continue;

    const status = (r?.status_norm || r?.status || "").toString().trim().toLowerCase();
    const valor = Number(r?.valor || r?.valor_total || 0) || 0;

    const quadraNome = typeof buildNomeQuadraDinamico === "function"
      ? buildNomeQuadraDinamico(r.quadras || null)
      : (r?.quadras?.nome || r?.quadras?.id || quadraId);

    if (!reservasPorQuadra.has(quadraId)) {
      reservasPorQuadra.set(quadraId, {
        quadra_id: quadraId,
        quadra_nome: quadraNome,
        total: 0,
        paid: 0,
        pending: 0,
        canceled: 0,
        receita_total: 0,
        receita_paga: 0,
      });
    }

    const info = reservasPorQuadra.get(quadraId);
    info.total += 1;
    info.receita_total += valor;

    if (status === "paid") {
      info.paid += 1;
      info.receita_paga += valor;
    } else if (status === "pending") {
      info.pending += 1;
    } else if (status === "canceled" || status === "cancelled") {
      info.canceled += 1;
    }
  }

  const reservas_por_quadra_status = Array.from(reservasPorQuadra.values())
    .sort((a, b) => (b.pending - a.pending) || (b.paid - a.paid) || (b.total - a.total))
    .slice(0, 30);

  // 2) Quadras sem regras de horário (diagnóstico)
  // OBS: aqui eu faço de forma segura: se der erro, não quebra o dashboard
  let quadras_sem_regras = [];
  try {
    const { data: quadrasAll, error: errQ } = await supabase
      .from("quadras")
      .select("id, empresa_id, tipo, material, modalidade, status, ativo");

    if (errQ) throw errQ;

    const { data: regrasAll, error: errR } = await supabase
      .from("regras_horarios")
      .select("id, quadra_id, ativo");

    if (errR) throw errR;

    const regrasAtivasPorQuadra = new Set(
      (regrasAll || [])
        .filter((r) => r && r.quadra_id && (r.ativo === true || r.ativo === 1))
        .map((r) => r.quadra_id)
    );

    const listaQuadras = quadrasAll || [];
    const sem = [];
    for (const q of listaQuadras) {
      if (!q?.id) continue;
      if (!regrasAtivasPorQuadra.has(q.id)) {
        // nome dinâmico (igual você usa no resto do sistema)
        const nome = typeof buildNomeQuadraDinamico === "function"
          ? buildNomeQuadraDinamico(q)
          : `${q.modalidade || "Modalidade"} - ${q.material || "Material"} (${q.tipo || "Tipo"})`;

        sem.push({
          quadra_id: q.id,
          empresa_id: q.empresa_id || null,
          quadra_nome: nome,
          status: q.status ?? null,
          ativo: q.ativo ?? null,
        });
      }
    }

    quadras_sem_regras = sem.slice(0, 50);
  } catch (e) {
    console.warn("[ADMIN/DASH] Falha ao calcular quadras_sem_regras:", e?.message || e);
    quadras_sem_regras = [];
  }

      // Mapa chave "YYYY-MM-DD|HH:MM" -> reserva
      const reservasPorChave = new Map();
      for (const r of reservasList) {
        const dataStr = String(r.data).slice(0, 10);
        const horaStr = String(r.hora).slice(0, 5); // HH:MM
        const key = `${dataStr}|${horaStr}`;
        reservasPorChave.set(key, r);
      }

      // 5) Busca BLOQUEIOS no período
      const { data: bloqueios, error: errBloqueios } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO);

      if (errBloqueios) {
        console.error("[AGENDA/SLOTS][GET] Erro ao buscar bloqueios_quadra:", errBloqueios);
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueios em /gestor/agenda/slots." });
      }

      const bloqueiosList = bloqueios || [];

      // Mapa por data "YYYY-MM-DD" -> lista de bloqueios
      const bloqueiosPorData = new Map();
      for (const b of bloqueiosList) {
        const dataStr = String(b.data).slice(0, 10);
        if (!bloqueiosPorData.has(dataStr)) {
          bloqueiosPorData.set(dataStr, []);
        }
        bloqueiosPorData.get(dataStr).push(b);
      }

      // 6) Filtro de status para resposta
      const filtroNorm = String(filtro || "todas").toLowerCase();
      const filtroValido = ["todas", "disponivel", "reservada", "bloqueada"];
      const filtroFinal = filtroValido.includes(filtroNorm) ? filtroNorm : "todas";

      // 7) Gera lista de datas do intervalo
      const dias = [];
      const dtCursor = new Date(dtInicio.getTime());
      while (dtCursor.getTime() <= dtFim.getTime()) {
        const iso = dtCursor.toISOString().slice(0, 10); // YYYY-MM-DD
        const weekday = dtCursor.getDay(); // 0=Domingo ... 6=Sábado

        const regrasDoDia = regrasPorDiaSemana.get(weekday) || [];
        const bloqueiosDoDia = bloqueiosPorData.get(iso) || [];

        const slotsDia = [];

        for (const regra of regrasDoDia) {
          // Para cada regra (ex.: 18:00–23:00), gera slots de 1h
          let slotsRegra = [];
          try {
            slotsRegra = gerarSlotsHoraCheia(regra.hora_inicio, regra.hora_fim);
          } catch (e) {
            console.error(
              "[AGENDA/SLOTS][GET] Erro ao gerar slots para regra:",
              regra,
              e
            );
            continue;
          }

          for (const slot of slotsRegra) {
            const horaInicioSlot = slot.hora_inicio; // HH:MM
            const horaFimSlot = slot.hora_fim;       // HH:MM

            // Verifica bloqueio (prioridade sobre reserva)
            let statusSlot = "DISPONIVEL";
            let reservaInfo = null;
            let bloqueioInfo = null;

            // 7.1) Checa bloqueio (se tiver bloqueio de dia inteiro ou faixa que pega esse horário)
            if (bloqueiosDoDia.length > 0) {
              for (const b of bloqueiosDoDia) {
                const bHoraInicio = b.hora_inicio;
                const bHoraFim = b.hora_fim;

                // Caso especial: bloqueio de dia inteiro (sem horas)
                if (!bHoraInicio && !bHoraFim) {
                  statusSlot = "BLOQUEADO";
                  bloqueioInfo = {
                    id: b.id,
                    motivo: b.motivo,
                    tipo: "DIA_INTEIRO",
                  };
                  break;
                }

                // Bloqueio com faixa de horário
                if (bHoraInicio && bHoraFim) {
                  const [bhIni, bmIni] = String(bHoraInicio)
                    .slice(0, 5)
                    .split(":")
                    .map((n) => Number(n));
                  const [bhFim, bmFim] = String(bHoraFim)
                    .slice(0, 5)
                    .split(":")
                    .map((n) => Number(n));

                  const [shIni, smIni] = horaInicioSlot
                    .split(":")
                    .map((n) => Number(n));

                  const slotMin = shIni * 60 + smIni;
                  const bIniMin = bhIni * 60 + bmIni;
                  const bFimMin = bhFim * 60 + bmFim;

                  // Se o início do slot está dentro da faixa de bloqueio → BLOQUEADO
                  if (slotMin >= bIniMin && slotMin < bFimMin) {
                    statusSlot = "BLOQUEADO";
                    bloqueioInfo = {
                      id: b.id,
                      motivo: b.motivo,
                      tipo: "FAIXA_HORARIO",
                    };
                    break;
                  }
                }
              }
            }

            // 7.2) Se NÃO estiver bloqueado, checa reserva
            if (statusSlot !== "BLOQUEADO") {
              const chave = `${iso}|${horaInicioSlot}`;
              const r = reservasPorChave.get(chave);
              if (r) {
                statusSlot = "RESERVADO";
                reservaInfo = {
                  id: r.id,
                  status: r.status,
                  preco_total: Number(r.preco_total || 0),
                  user_cpf: r.user_cpf,
                  phone: r.phone,
                };
              }
            }

            // 7.3) Aplica filtro de status
            const statusLower = statusSlot.toLowerCase(); // disponivel | reservado | bloqueado
            if (
              filtroFinal !== "todas" &&
              !(
                (filtroFinal === "disponivel" && statusLower === "disponivel") ||
                (filtroFinal === "reservada" && statusLower === "reservado") ||
                (filtroFinal === "bloqueada" && statusLower === "bloqueado")
              )
            ) {
              // Não entra no resultado se não bater com o filtro
              continue;
            }

            slotsDia.push({
              data: iso, // YYYY-MM-DD
              hora_inicio: horaInicioSlot,
              hora_fim: horaFimSlot,
              status: statusSlot, // "DISPONIVEL" | "RESERVADO" | "BLOQUEADO"
              reserva: reservaInfo,
              bloqueio: bloqueioInfo,
              preco_hora: Number(regra.valor || 0),
              regra_id: regra.id,
            });
          }
        }

        dias.push({
          data: iso,
          dia_semana: weekday, // 0=Domingo ... 6=Sábado
          slots: slotsDia,
        });

        // Próximo dia
        dtCursor.setDate(dtCursor.getDate() + 1);
      }

      return res.json({
        quadra_id: quadraId,
        data_inicio: dataInicioISO,
        data_fim: dataFimISO,
        filtro: filtroFinal,
        dias,
      });
    } catch (err) {
      console.error("[AGENDA/SLOTS][GET] Erro geral:", err);
      return res.status(500).json({
        error: "Erro interno em /gestor/agenda/slots.",
      });
    }
  }
);

// POST /gestor/agenda/bloqueios/lote
// Cria bloqueios manuais EM LOTE para várias quadras na MESMA data/horário
// Body:
// {
//   "quadraIds": ["idQuadraA", "idQuadraB", ...],
//   "data": "2025-12-24",
//   "horaInicio": "18:00",
//   "horaFim": "23:59",
//   "motivo": "Natal - complexo fechado"
// }
app.post(
  "/gestor/agenda/bloqueios/lote",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraIds, data, horaInicio, horaFim, motivo } = req.body || {};

      if (!Array.isArray(quadraIds) || quadraIds.length === 0) {
        return res.status(400).json({
          error:
            "Informe pelo menos uma quadra em quadraIds em /gestor/agenda/bloqueios/lote.",
        });
      }

      if (!data || !horaInicio || !horaFim) {
        return res.status(400).json({
          error: "Campos obrigatórios: data, horaInicio e horaFim.",
        });
      }

      // Confere se todas as quadras pertencem ao gestor
      const { data: quadrasDoGestor, error: erroQuadras } = await supabase
        .from("quadras")
        .select("id, gestor_id")
        .in("id", quadraIds)
        .eq("gestor_id", gestorId);

      if (erroQuadras) {
        console.error(
          "[AGENDA/BLOQUEIOS-LOTE] Erro ao buscar quadras do gestor:",
          erroQuadras
        );
        return res
          .status(500)
          .json({ error: "Erro ao validar quadras do gestor." });
      }

      if (!quadrasDoGestor || quadrasDoGestor.length !== quadraIds.length) {
        return res.status(403).json({
          error:
            "Uma ou mais quadras não pertencem a este gestor (ou não foram encontradas).",
        });
      }

      const inserts = quadraIds.map((quadraId) => ({
        quadra_id: quadraId,
        data,
        hora_inicio: horaInicio,
        hora_fim: horaFim,
        motivo,
        criado_por: gestorId,
      }));

      const { data: bloqueiosCriados, error: erroInsert } = await supabase
        .from("bloqueios_quadra")
        .insert(inserts)
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo,
          created_at
        `
        );

      if (erroInsert) {
        console.error(
          "[AGENDA/BLOQUEIOS-LOTE] Erro ao criar bloqueios em lote:",
          erroInsert
        );
        return res
          .status(500)
          .json({ error: "Erro ao criar bloqueios em lote." });
      }

      return res.status(201).json({ bloqueios: bloqueiosCriados || [] });
    } catch (err) {
      console.error("[AGENDA/BLOQUEIOS-LOTE][POST] Erro geral:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao criar bloqueios em lote." });
    }
  }
);

// PUT /gestor/agenda/bloqueios/:id
// Edição de um bloqueio (alterar data, horários ou motivo)
app.put(
  "/gestor/agenda/bloqueios/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const bloqueioId = req.params.id;
      const { quadraId, data, horaInicio, horaFim, motivo } = req.body || {};

      if (!bloqueioId || !quadraId) {
        return res.status(400).json({
          error:
            "Campos obrigatórios: id do bloqueio na URL e quadraId no body em /gestor/agenda/bloqueios/:id.",
        });
      }

      await validarQuadraDoGestor(quadraId, gestorId);

      const { data: updated, error } = await supabase
        .from("bloqueios_quadra")
        .update({
          quadra_id: quadraId,
          data,
          hora_inicio: horaInicio,
          hora_fim: horaFim,
          motivo,
          criado_por: gestorId,
        })
        .eq("id", bloqueioId)
        .eq("quadra_id", quadraId)
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo,
          created_at
        `
        )
        .single();

      if (error) {
        console.error(
          "[AGENDA/BLOQUEIOS][PUT] Erro ao atualizar bloqueio:",
          error
        );
        return res
          .status(500)
          .json({ error: "Erro ao atualizar bloqueio da quadra." });
      }

      if (!updated) {
        return res
          .status(404)
          .json({ error: "Bloqueio não encontrado para este id." });
      }

      return res.json({ bloqueio: updated });
    } catch (err) {
      console.error("[AGENDA/BLOQUEIOS][PUT] Erro geral:", err);
      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }
      return res
        .status(500)
        .json({ error: "Erro interno ao atualizar bloqueio da quadra." });
    }
  }
);

// DELETE /gestor/agenda/bloqueios/:id
// Remove bloqueio (libera de novo o horário) usando apenas o ID
app.delete(
  "/gestor/agenda/bloqueios/:id",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const bloqueioId = req.params.id;

      if (!bloqueioId) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em /gestor/agenda/bloqueios/:id.",
        });
      }

      // Busca bloqueio para descobrir a quadra e validar a posse
      const { data: bloqueio, error: erroBusca } = await supabase
        .from("bloqueios_quadra")
        .select("id, quadra_id")
        .eq("id", bloqueioId)
        .single();

      if (erroBusca) {
        console.error(
          "[AGENDA/BLOQUEIOS][DELETE] Erro ao buscar bloqueio:",
          erroBusca
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueio antes de excluir." });
      }

      if (!bloqueio) {
        return res
          .status(404)
          .json({ error: "Bloqueio não encontrado." });
      }

      await validarQuadraDoGestor(bloqueio.quadra_id, gestorId);

      const { error: erroDelete } = await supabase
        .from("bloqueios_quadra")
        .delete()
        .eq("id", bloqueioId);

      if (erroDelete) {
        console.error(
          "[AGENDA/BLOQUEIOS][DELETE] Erro ao excluir bloqueio:",
          erroDelete
        );
        return res
          .status(500)
          .json({ error: "Erro interno ao excluir bloqueio." });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[AGENDA/BLOQUEIOS][DELETE] Erro geral:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao excluir bloqueio." });
    }
  }
);

// -----------------------------------------
// SLOTS DA AGENDA (VISUALIZAÇÃO ESTILO CINEMA)
// -----------------------------------------
//
// GET /gestor/agenda/slots
//
// Query params esperados:
//   - quadraId      (obrigatório) → UUID da quadra
//   - periodo       (opcional)    → "semana" | "mes" | "intervalo"
//   - dataInicio    (opcional)    → AAAA-MM-DD ou DD/MM/AAAA
//   - dataFim       (opcional)    → AAAA-MM-DD ou DD/MM/AAAA (usado se periodo = "intervalo")
//   - filtro        (opcional)    → "disponivel" | "reservada" | "bloqueada" | "todas"
//
// Regras de negócio (para cada slot de 1h):
//   - Lê regras_horarios (recorrente por dia_da_semana)
//   - Gera slots de 1h com gerarSlotsHoraCheia(hora_inicio, hora_fim)
//   - Marca como:
//       status = "RESERVADO" se houver reserva (status pending/paid)
//       status = "BLOQUEADO" se cair em intervalo de bloqueio
//       status = "DISPONIVEL" caso contrário
//
//   - Filtro "disponivel" → só slots DISPO
//     Filtro "reservada"  → só slots RESERVADO
//     Filtro "bloqueada"  → só slots BLOQUEADO
//     Filtro "todas" (default) → todos
//
// OBS: essa rota NÃO cria nem edita nada, apenas devolve os slots
//      para o painel desenhar os botões verde/vermelho/cinza.
//
app.get(
  "/gestor/agenda/slots",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const {
        quadraId,
        periodo = "semana",
        dataInicio,
        dataFim,
        filtro = "todas",
      } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro quadraId é obrigatório em /gestor/agenda/slots.",
        });
      }

      // 1) Garante que a quadra pertence ao gestor logado
      try {
        await validarQuadraDoGestor(quadraId, gestorId);
      } catch (err) {
        console.error("[AGENDA/SLOTS] Erro em validarQuadraDoGestor:", err);
        if (err.message === "Quadra não pertence a este gestor") {
          return res.status(403).json({ error: err.message });
        }
        if (err.message === "Quadra não encontrada") {
          return res.status(404).json({ error: err.message });
        }
        return res
          .status(500)
          .json({ error: "Erro ao validar quadra em /gestor/agenda/slots." });
      }

      // 2) Calcula intervalo de datas (dataInicio/dataFim)
      //    - se nada for informado → hoje + 6 dias (7 dias no total)
      //    - se periodo = "semana" → 7 dias a partir de dataInicio (ou hoje)
      //    - se periodo = "mes"    → 30 dias a partir de dataInicio (ou hoje)
      //    - se periodo = "intervalo" → usa dataInicio + dataFim
      function normalizarDataBase(str) {
        if (!str) return null;
        const dt = parseDataAgendamentoBr(str); // já aceita AAAA-MM-DD ou DD/MM/AAAA
        return dt;
      }

      let dtInicio;
      let dtFim;

      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      if (String(periodo).toLowerCase() === "intervalo") {
        dtInicio = normalizarDataBase(dataInicio) || hoje;
        dtFim =
          normalizarDataBase(dataFim) ||
          new Date(dtInicio.getTime() + 6 * 24 * 60 * 60 * 1000);
      } else {
        dtInicio = normalizarDataBase(dataInicio) || hoje;
        const baseMs = dtInicio.getTime();

        if (String(periodo).toLowerCase() === "mes") {
          dtFim = new Date(baseMs + 29 * 24 * 60 * 60 * 1000); // 30 dias
        } else {
          // default "semana"
          dtFim = new Date(baseMs + 6 * 24 * 60 * 60 * 1000); // 7 dias
        }
      }

      // Garante dtInicio <= dtFim
      if (dtFim.getTime() < dtInicio.getTime()) {
        const tmp = dtInicio;
        dtInicio = dtFim;
        dtFim = tmp;
      }

      const dataInicioISO = formatDateISO(dtInicio);
      const dataFimISO = formatDateISO(dtFim);

      // 3) Busca REGRAS de horário da quadra (por dia_da_semana)
      const { data: regras, error: regrasError } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor,
          created_at
        `
        )
        .eq("id_quadra", quadraId);

      if (regrasError) {
        console.error("[AGENDA/SLOTS] Erro ao buscar regras_horarios:", regrasError);
        return res
          .status(500)
          .json({ error: "Erro ao buscar regras de horário da quadra." });
      }

      // Mapa por dia_da_semana → [regras...]
      const regrasPorDia = new Map();
      (regras || []).forEach((r) => {
        const dia = Number(r.dia_da_semana);
        if (!regrasPorDia.has(dia)) {
          regrasPorDia.set(dia, []);
        }
        regrasPorDia.get(dia).push(r);
      });

      // 4) Busca BLOQUEIOS no intervalo (por data específica)
      const { data: bloqueios, error: bloqueiosError } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO);

      if (bloqueiosError) {
        console.error("[AGENDA/SLOTS] Erro ao buscar bloqueios_quadra:", bloqueiosError);
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueios da quadra." });
      }

      // 5) Busca RESERVAS no intervalo (apenas pending/paid)
      const { data: reservas, error: reservasError } = await supabase
        .from("reservas")
        .select(
          `
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total,
          pago_via_pix,
          user_cpf,
          phone,
          usuario_id
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO)
        .in("status", ["pending", "paid", "pendente", "pago"]);


      if (reservasError) {
        console.error("[AGENDA/SLOTS] Erro ao buscar reservas:", reservasError);
        return res
          .status(500)
          .json({ error: "Erro ao buscar reservas da quadra." });
      }

      const filtroNorm = String(filtro || "todas").toLowerCase();

      // Helpers para testar conflito
      function existeReserva(dateISO, horaInicioSlot) {
        return reservas?.find(
          (r) =>
            r.data === dateISO &&
            r.hora === horaInicioSlot &&
            (r.status === "pending" || r.status === "paid")
        );
      }

      function slotBloqueado(dateISO, horaInicioSlot, horaFimSlot) {
        if (!bloqueios || bloqueios.length === 0) return null;

        return (
          bloqueios.find((b) => {
            if (b.data !== dateISO) return false;
            if (!b.hora_inicio || !b.hora_fim) return false;

            // Considera bloqueado se o início do slot está dentro do intervalo [hora_inicio, hora_fim)
            return (
              horaInicioSlot >= b.hora_inicio &&
              horaInicioSlot < b.hora_fim
            );
          }) || null
        );
      }

      // 6) Gera os slots dia a dia
      const slots = [];
      const umDiaMs = 24 * 60 * 60 * 1000;

      for (
        let time = dtInicio.getTime();
        time <= dtFim.getTime();
        time += umDiaMs
      ) {
        const dia = new Date(time);
        dia.setHours(0, 0, 0, 0);

        const diaSemana = dia.getDay(); // 0=Domingo ... 6=Sábado
        const diaISO = formatDateISO(dia);

        const regrasDoDia = regrasPorDia.get(diaSemana) || [];
        if (!regrasDoDia.length) {
          // Nenhuma regra para esse dia_da_semana → sem slots neste dia
          continue;
        }

        for (const regra of regrasDoDia) {
          let slotsDaRegra = [];
          try {
            slotsDaRegra = gerarSlotsHoraCheia(
              regra.hora_inicio,
              regra.hora_fim
            );
          } catch (errSlots) {
            console.error(
              "[AGENDA/SLOTS] Erro em gerarSlotsHoraCheia:",
              errSlots
            );
            continue;
          }

          for (const slot of slotsDaRegra) {
            const horaInicioSlot = slot.hora_inicio;
            const horaFimSlot = slot.hora_fim;

            const reserva = existeReserva(diaISO, horaInicioSlot);
            const bloqueio = slotBloqueado(
              diaISO,
              horaInicioSlot,
              horaFimSlot
            );

            let status = "DISPONIVEL";

            if (reserva) {
              status = "RESERVADO";
            } else if (bloqueio) {
              status = "BLOQUEADO";
            }

            // Aplica filtros
            if (filtroNorm === "disponivel" && status !== "DISPONIVEL") {
              continue;
            }
            if (filtroNorm === "reservada" && status !== "RESERVADO") {
              continue;
            }
            if (filtroNorm === "bloqueada" && status !== "BLOQUEADO") {
              continue;
            }

            slots.push({
              quadra_id: quadraId,
              data: diaISO,
              dia_semana: diaSemana, // 0..6
              hora_inicio: horaInicioSlot,
              hora_fim: horaFimSlot,
              status, // "DISPONIVEL" | "RESERVADO" | "BLOQUEADO"
              // ajuda para o front:
              tem_reserva: !!reserva,
              tem_bloqueio: !!bloqueio,
              reserva_id: reserva ? reserva.id : null,
              bloqueio_id: bloqueio ? bloqueio.id : null,
              preco_hora: regra.valor,
            });
          }
        }
      }

      return res.json({
        quadra_id: quadraId,
        data_inicio: dataInicioISO,
        data_fim: dataFimISO,
        periodo: String(periodo).toLowerCase(),
        filtro: filtroNorm,
        total_slots: slots.length,
        slots,
      });
    } catch (err) {
      console.error("[AGENDA/SLOTS] Erro geral:", err);
      return res
        .status(500)
        .json({ error: "Erro interno em /gestor/agenda/slots." });
    }
  }
);


// -----------------------------------------
// GET /gestor/agenda/grade
// Gera "grade de cinema" para uma quadra:
// - Usa regras_horarios (recorrentes por dia_da_semana)
// - Usa reservas (por data/hora)
// - Usa bloqueios_quadra (por data/faixa de horário)
// Query:
//   - quadraId   (obrigatório)
//   - dataInicio (opcional – AAAA-MM-DD ou DD/MM/AAAA, default = hoje)
//   - dias       (opcional – default 7, máximo 31)
// -----------------------------------------
app.get(
  "/gestor/agenda/grade",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId, dataInicio, dias } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro quadraId é obrigatório em /gestor/agenda/grade.",
        });
      }

      // 1) Garante que a quadra pertence ao Gestor logado
      try {
        await validarQuadraDoGestor(quadraId, gestorId);
      } catch (e) {
        console.error("[AGENDA/GRADE] Quadra inválida:", e);
        return res.status(403).json({
          error: "Quadra não pertence a este gestor ou não existe.",
        });
      }

      // 2) Define data inicial (default = hoje)
      let dataInicioObj;
      if (dataInicio) {
        dataInicioObj = parseDataAgendamentoBr(dataInicio);
        if (!dataInicioObj) {
          return res.status(400).json({
            error:
              "Parâmetro dataInicio inválido em /gestor/agenda/grade. Use AAAA-MM-DD ou DD/MM/AAAA.",
          });
        }
      } else {
        const hoje = new Date();
        dataInicioObj = new Date(
          hoje.getFullYear(),
          hoje.getMonth(),
          hoje.getDate()
        );
      }

      const diasIntRaw = dias ? parseInt(dias, 10) : 7;
      const diasInt =
        Number.isFinite(diasIntRaw) && diasIntRaw > 0
          ? Math.min(diasIntRaw, 31)
          : 7;

      const dataInicioISO = formatDateISO(dataInicioObj);
      if (!dataInicioISO) {
        return res.status(400).json({
          error: "Falha ao normalizar dataInicio em /gestor/agenda/grade.",
        });
      }

      function addDays(base, delta) {
        const d = new Date(base.getTime());
        d.setDate(d.getDate() + delta);
        return d;
      }

      const dataFimObj = addDays(dataInicioObj, diasInt - 1);
      const dataFimISO = formatDateISO(dataFimObj);

      // 3) Carrega regras, reservas e bloqueios no intervalo
      const [regrasResp, reservasResp, bloqueiosResp] = await Promise.all([
        supabase
          .from("regras_horarios")
          .select("id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor")
          .eq("id_quadra", quadraId),

        supabase
          .from("reservas")
          .select(
            `
            id,
            quadra_id,
            data,
            hora,
            status,
            preco_total,
            user_cpf,
            phone,
            pago_via_pix,
            id_transacao_pix,
            usuario_id
          `
          )
          .eq("quadra_id", quadraId)
          .gte("data", dataInicioISO)
          .lte("data", dataFimISO),

        supabase
          .from("bloqueios_quadra")
          .select("id, quadra_id, data, hora_inicio, hora_fim, motivo")
          .eq("quadra_id", quadraId)
          .gte("data", dataInicioISO)
          .lte("data", dataFimISO),
      ]);

      const { data: regrasRaw, error: regrasError } = regrasResp;
      const { data: reservasRaw, error: reservasError } = reservasResp;
      const { data: bloqueiosRaw, error: bloqueiosError } = bloqueiosResp;

      if (regrasError) {
        console.error(
          "[AGENDA/GRADE] Erro ao buscar regras_horarios:",
          regrasError
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar regras de horário." });
      }

      if (reservasError) {
        console.error(
          "[AGENDA/GRADE] Erro ao buscar reservas:",
          reservasError
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar reservas da quadra." });
      }

      if (bloqueiosError) {
        console.error(
          "[AGENDA/GRADE] Erro ao buscar bloqueios:",
          bloqueiosError
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueios da quadra." });
      }

      const regras = regrasRaw || [];
      const reservas = reservasRaw || [];
      const bloqueios = bloqueiosRaw || [];

      // 4) Indexa regras por dia_da_semana (0=Dom...6=Sáb)
      const regrasPorDia = {};
      for (const r of regras) {
        const dia = Number(r.dia_da_semana);
        if (!Number.isFinite(dia)) continue;
        if (!regrasPorDia[dia]) regrasPorDia[dia] = [];
        regrasPorDia[dia].push(r);
      }

      // 5) Indexa reservas por chave "data::hora_inicio"
      const reservasPorChave = {};
      for (const r of reservas) {
        const dataKey = String(r.data).slice(0, 10);
        const horaKey = String(r.hora).slice(0, 5);
        const chave = `${dataKey}::${horaKey}`;
        if (!reservasPorChave[chave]) reservasPorChave[chave] = [];
        reservasPorChave[chave].push(r);
      }

      // 6) Agrupa bloqueios por data
      const bloqueiosPorData = {};
      for (const b of bloqueios) {
        const dataKey = String(b.data).slice(0, 10);
        if (!bloqueiosPorData[dataKey]) bloqueiosPorData[dataKey] = [];
        bloqueiosPorData[dataKey].push(b);
      }

      // Helper para comparar horário em minutos
      function horaParaMinutos(hora) {
        const [hStr, mStr] = String(hora).split(":");
        const h = parseInt(hStr, 10);
        const m = parseInt(mStr || "0", 10);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
      }

      // 7) Monta grade dia a dia
      const diasGrade = [];

      for (let offset = 0; offset < diasInt; offset++) {
        const dt = addDays(dataInicioObj, offset);
        const dataISO = formatDateISO(dt);
        const diaSemana = dt.getDay(); // 0=Dom ... 6=Sáb

        const regrasDoDia = regrasPorDia[diaSemana] || [];
        const bloqueiosDoDia = bloqueiosPorData[dataISO] || [];

        const slots = [];

        for (const regra of regrasDoDia) {
          const slotsRegra = gerarSlotsHoraCheia(
            regra.hora_inicio,
            regra.hora_fim
          ); // [{hora_inicio, hora_fim}, 1h cada}

          for (const slot of slotsRegra) {
            const horaIni = String(slot.hora_inicio).slice(0, 5);
            const horaFim = String(slot.hora_fim).slice(0, 5);
            const chave = `${dataISO}::${horaIni}`;

            let status = "LIVRE";
            let reservaPrincipal = null;
            let bloqueioPrincipal = null;

            // 7.1) Verifica se há reserva nesse slot
// ✅ Regra: só BLOQUEIA o horário se a reserva estiver pending ou paid
const reservasSlot = reservasPorChave[chave] || [];

if (reservasSlot.length > 0) {
  // Se houver mais de 1 por algum bug, prioriza paid > pending > canceled
  const prioridade = { paid: 2, pending: 1, canceled: 0 };

  reservasSlot.sort((a, b) => {
    const sa = normalizeReservaStatus(a?.status);
    const sb = normalizeReservaStatus(b?.status);
    return (prioridade[sb] ?? 0) - (prioridade[sa] ?? 0);
  });

  reservaPrincipal = reservasSlot[0];

  if (isReservaBloqueante(reservaPrincipal?.status)) {
    status = "RESERVADA";
  } else {
    // canceled NÃO bloqueia: mantém DISPONIVEL (salvo bloqueio manual)
    // status permanece como estava (normalmente "DISPONIVEL")
  }
}


            // 7.2) Se ainda não estiver RESERVADA, verifica bloqueios
            if (status === "LIVRE" && bloqueiosDoDia.length > 0) {
              const inicioSlotMin = horaParaMinutos(horaIni);
              const fimSlotMin = horaParaMinutos(horaFim);

              for (const b of bloqueiosDoDia) {
                const iniBloq = horaParaMinutos(b.hora_inicio);
                const fimBloq = horaParaMinutos(b.hora_fim);

                if (
                  iniBloq != null &&
                  fimBloq != null &&
                  inicioSlotMin < fimBloq &&
                  fimSlotMin > iniBloq
                ) {
                  status = "BLOQUEADO";
                  bloqueioPrincipal = b;
                  break;
                }
              }
            }

            slots.push({
              data: dataISO,
              hora_inicio: horaIni,
              hora_fim: horaFim,
              status, // "LIVRE" | "RESERVADA" | "BLOQUEADA"

              // Se RESERVADA, dados básicos da reserva
              reserva_id: reservaPrincipal ? reservaPrincipal.id : null,
              reserva_status: reservaPrincipal
                ? reservaPrincipal.status
                : null,
              reserva_cpf: reservaPrincipal
                ? reservaPrincipal.user_cpf
                : null,
              reserva_phone: reservaPrincipal
                ? reservaPrincipal.phone
                : null,
              reserva_preco_total: reservaPrincipal
                ? reservaPrincipal.preco_total
                : null,

              // Se BLOQUEADA, dados básicos do bloqueio
              bloqueio_id: bloqueioPrincipal ? bloqueioPrincipal.id : null,
              bloqueio_motivo: bloqueioPrincipal
                ? bloqueioPrincipal.motivo
                : null,
            });
          }
        }

        diasGrade.push({
          data: dataISO,
          dia_semana: diaSemana,
          slots,
        });
      }

      return res.json({
        quadraId,
        data_inicio: dataInicioISO,
        data_fim: dataFimISO,
        dias: diasInt,
        dias_grade: diasGrade,
      });
    } catch (err) {
      console.error("[AGENDA/GRADE] Erro inesperado:", err);
      return res.status(500).json({
        error: "Erro interno em /gestor/agenda/grade.",
      });
    }
  }
);

// -----------------------------------------
// GET /gestor/agenda/quadra-grid
// → Retorna GRID de horários estilo "cinema"
// Query:
//   - quadra_id   (obrigatório)
//   - data_inicio (opcional, AAAA-MM-DD ou DD/MM/AAAA; default = hoje)
//   - dias        (opcional, default = 7, máx = 60)
// -----------------------------------------
app.get(
  "/gestor/agenda/quadra-grid",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const quadraId = req.query.quadra_id || req.query.quadraId;

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro quadra_id é obrigatório em /gestor/agenda/quadra-grid",
        });
      }

      // 1) Garante que a quadra pertence ao GESTOR logado
      const { data: quadra, error: quadraError } = await supabase
        .from("quadras")
        .select(
          `
          id,
          gestor_id,
          empresa_id,
          tipo,
          material,
          modalidade,
          aviso
        `
        )
        .eq("id", quadraId)
        .maybeSingle();

      if (quadraError) {
        console.error(
          "[GESTOR/AGENDA/GRID] Erro ao buscar quadra:",
          quadraError
        );
        return res.status(500).json({
          error: "Erro ao buscar quadra em /gestor/agenda/quadra-grid.",
        });
      }

      if (!quadra || quadra.gestor_id !== gestorId) {
        return res.status(403).json({
          error: "Quadra não encontrada ou não pertence a este gestor.",
        });
      }

      // 2) Define período (data_inicio + dias)
      const { data_inicio: dataInicioRaw, dias: diasRaw } = req.query;

      let dataInicioDate;
      if (dataInicioRaw) {
        // Usa helper já existente que aceita AAAA-MM-DD ou DD/MM/AAAA
        const parsed = parseDataAgendamentoBr(String(dataInicioRaw));
        if (!parsed || !(parsed instanceof Date)) {
          return res.status(400).json({
            error:
              "data_inicio inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /gestor/agenda/quadra-grid.",
          });
        }
        dataInicioDate = parsed;
      } else {
        dataInicioDate = new Date();
      }

      // Zera horário da data de início
      dataInicioDate.setHours(0, 0, 0, 0);

      let dias = parseInt(diasRaw, 10);
      if (Number.isNaN(dias) || dias <= 0) dias = 7;
      if (dias > 60) dias = 60;

      // Monta array de dias (Date + ISO + dia_da_semana)
      const diasArray = [];
      for (let i = 0; i < dias; i++) {
        const d = new Date(dataInicioDate);
        d.setDate(d.getDate() + i);
        const iso = formatDateISO(d); // helper já existente
        diasArray.push({
          dateObj: d,
          iso,
          diaSemana: d.getDay(), // 0-dom, 1-seg, ... 6-sáb
        });
      }

      if (diasArray.length === 0) {
        return res.json({
          quadra: null,
          periodo: null,
          dias: [],
        });
      }

      const fromISO = diasArray[0].iso;
      const toISO = diasArray[diasArray.length - 1].iso;

      // 3) Busca regras_horarios da quadra (apenas dias da semana relevantes)
      const diasSemanaUnicos = Array.from(
        new Set(diasArray.map((d) => d.diaSemana))
      );

      const { data: regras, error: regrasError } = await supabase
        .from("regras_horarios")
        .select(`
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor
        `)
        .eq("id_quadra", quadraId)
        .in("dia_da_semana", diasSemanaUnicos);

      if (regrasError) {
        console.error(
          "[GESTOR/AGENDA/GRID] Erro ao buscar regras_horarios:",
          regrasError
        );
        return res.status(500).json({
          error:
            "Erro ao buscar regras de horários em /gestor/agenda/quadra-grid.",
        });
      }

      const regrasList = regras || [];

      // 4) Busca reservas (pending/paid) no intervalo
      const { data: reservas, error: reservasError } = await supabase
        .from("reservas")
        .select(`
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total,
          pago_via_pix
        `)
        .eq("quadra_id", quadraId)
        .gte("data", fromISO)
        .lte("data", toISO)
        .in("status", ["pending", "paid", "pendente", "pago"]);


      if (reservasError) {
        console.error(
          "[GESTOR/AGENDA/GRID] Erro ao buscar reservas:",
          reservasError
        );
        return res.status(500).json({
          error: "Erro ao buscar reservas em /gestor/agenda/quadra-grid.",
        });
      }

      const reservasList = reservas || [];

      // 5) Busca bloqueios_quadra no intervalo
      const { data: bloqueios, error: bloqueiosError } = await supabase
        .from("bloqueios_quadra")
        .select(`
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `)
        .eq("quadra_id", quadraId)
        .gte("data", fromISO)
        .lte("data", toISO);

      if (bloqueiosError) {
        console.error(
          "[GESTOR/AGENDA/GRID] Erro ao buscar bloqueios:",
          bloqueiosError
        );
        return res.status(500).json({
          error: "Erro ao buscar bloqueios em /gestor/agenda/quadra-grid.",
        });
      }

      const bloqueiosList = bloqueios || [];

      // 6) Indexa reservas por (data :: hora_inicio)
      const reservasMap = new Map();
      for (const r of reservasList) {
        const dia = typeof r.data === "string" ? r.data.slice(0, 10) : null;
        const hora = String(r.hora || "").slice(0, 5); // HH:MM

        if (!dia || !hora) continue;

        const key = `${dia}::${hora}`;
        const existente = reservasMap.get(key);

        // Se já houver uma reserva nesse slot, prioriza "paid"
        if (!existente) {
          reservasMap.set(key, r);
        } else {
          const exPaid = existente.status === "paid";
          const novoPaid = r.status === "paid";
          if (!exPaid && novoPaid) {
            reservasMap.set(key, r);
          }
        }
      }

      // Helper: encontra bloqueio que atinge determinado slot
      function encontrarBloqueioParaSlot(diaISO, horaSlot) {
        // horaSlot = "HH:MM"
        for (const b of bloqueiosList) {
          const diaBloq =
            typeof b.data === "string" ? b.data.slice(0, 10) : null;
          if (diaBloq !== diaISO) continue;

          const hIni = String(b.hora_inicio || "").slice(0, 5);
          const hFim = String(b.hora_fim || "").slice(0, 5);

          if (horaSlot >= hIni && horaSlot < hFim) {
            return b;
          }
        }
        return null;
      }

      // 7) Monta GRID por dia
      const diasResultado = [];

      for (const diaInfo of diasArray) {
        const { iso: diaISO, diaSemana } = diaInfo;

        // Regras para este dia da semana
        const regrasDia = regrasList.filter(
          (r) => Number(r.dia_da_semana) === Number(diaSemana)
        );

        const slots = [];

        for (const regra of regrasDia) {
          const horaInicioRegra = String(regra.hora_inicio || "").slice(0, 5);
          const horaFimRegra = String(regra.hora_fim || "").slice(0, 5);

          // Usa helper já existente para gerar slots cheios (18:00-19:00 etc.)
          const slotsRegra = gerarSlotsHoraCheia(
            horaInicioRegra,
            horaFimRegra
          );

          for (const s of slotsRegra) {
            const inicio = s.inicio; // HH:MM
            const fim = s.fim; // HH:MM

            const key = `${diaISO}::${inicio}`;
            const reserva = reservasMap.get(key) || null;
            const bloqueio = encontrarBloqueioParaSlot(diaISO, inicio);

            let status = "DISPONIVEL"; // default
            let origem_reserva = null;
            let reserva_id = null;
            let bloqueio_id = null;
            let motivo_bloqueio = null;

            if (bloqueio) {
              status = "BLOQUEADA"; // botão cinza
              bloqueio_id = bloqueio.id;
              motivo_bloqueio = bloqueio.motivo || null;
            } else if (reserva) {
              status = "RESERVADA"; // botão vermelho
              reserva_id = reserva.id;
              origem_reserva = reserva.pago_via_pix ? "FLOW" : "PAINEL";
            } else {
              status = "DISPONIVEL"; // botão verde
            }

            slots.push({
              hora_inicio: inicio,
              hora_fim: fim,
              status, // "DISPONIVEL" | "RESERVADA" | "BLOQUEADA"
              reserva_id,
              origem_reserva, // "FLOW" (PIX) ou "PAINEL" (manual)
              bloqueio_id,
              motivo_bloqueio,
              preco_hora: Number(regra.valor || 0),
            });
          }
        }

        diasResultado.push({
          data: diaISO,
          dia_semana: diaSemana,
          slots,
        });
      }

      // 8) Monta resposta final para o frontend estilo cinema
      let nomeQuadra = null;
      try {
        // Helper já existe e é usado em dashboards
        nomeQuadra = buildNomeQuadraDinamico(quadra);
      } catch (e) {
        nomeQuadra = quadra.tipo || "Quadra";
      }

      return res.json({
        quadra: {
          id: quadra.id,
          nome: nomeQuadra,
          aviso: quadra.aviso || null,
        },
        periodo: {
          data_inicio: fromISO,
          data_fim: toISO,
          dias,
        },
        dias: diasResultado,
      });
    } catch (err) {
      console.error("[GESTOR/AGENDA/GRID] Erro inesperado:", err);
      return res.status(500).json({
        error: "Erro interno em /gestor/agenda/quadra-grid.",
      });
    }
  }
);
// ======================================
// ROTAS ADMIN - AGENDA (GLOBAL)
// - Clone do módulo Agenda do Gestor
// - Admin pode ver/criar/alterar/excluir regras e bloqueios de QUALQUER quadra
// ======================================

// Helper: valida se quadra existe (sem checar dono)
async function adminValidarQuadraExiste(quadraId) {
  if (!quadraId) return { ok: false, status: 400, error: "quadraId é obrigatório." };

  const { data, error } = await supabase
    .from("quadras")
    .select("id, empresa_id, gestor_id, status")
    .eq("id", quadraId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Quadra não encontrada." };

  return { ok: true, quadra: data };
}

// =========================================
// AGENDA / REGRAS (PAINEL ADMIN)
// =========================================
// GET    /admin/agenda/regras?quadraId=...
// POST   /admin/agenda/regras/lote
// PUT    /admin/agenda/regras/:id
// DELETE /admin/agenda/regras/:id
//
// Mesmas colunas do Gestor: id_quadra, dia_da_semana, hora_inicio, hora_fim, valor
// Diferença: Admin valida apenas se a quadra existe (visão global).
// =========================================

// -----------------------------------------
// GET /admin/agenda/regras
// Query: quadraId (obrigatório)
// -----------------------------------------
app.get(
  "/admin/agenda/regras",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { quadraId } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /admin/agenda/regras.",
        });
      }

      // Admin: valida apenas se a quadra existe
      const vr = await adminValidarQuadraExiste(quadraId);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      const { data, error } = await supabase
        .from("regras_horarios")
        .select("id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor")
        .eq("id_quadra", quadraId)
        .order("dia_da_semana", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (error) {
        console.error("[ADMIN/AGENDA][REGRAS][GET] Erro ao buscar regras_horarios:", error);
        return res.status(500).json({ error: "Erro ao buscar regras em /admin/agenda/regras." });
      }

      return res.json(data || []);
    } catch (err) {
      console.error("[ADMIN/AGENDA][REGRAS][GET] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/regras." });
    }
  }
);

// -----------------------------------------
// POST /admin/agenda/regras/lote
// Body: { quadraId, regras: [{ dia_da_semana, hora_inicio, hora_fim, valor }] }
// - Mesmo padrão do Gestor: substitui todas as regras da quadra
// -----------------------------------------
app.post(
  "/admin/agenda/regras/lote",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel.id;
      const { quadraId, regras } = req.body || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "quadraId é obrigatório em /admin/agenda/regras/lote.",
        });
      }

      const vr = await adminValidarQuadraExiste(quadraId);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      if (!Array.isArray(regras)) {
        return res.status(400).json({
          error: "regras deve ser um array em /admin/agenda/regras/lote.",
        });
      }

      // (padrão do Gestor) remove tudo e insere de novo
      const { error: delErr } = await supabase
        .from("regras_horarios")
        .delete()
        .eq("id_quadra", quadraId);

      if (delErr) {
        console.error("[ADMIN/AGENDA][REGRAS-LOTE][POST] Erro ao limpar regras:", delErr);
        return res.status(500).json({ error: "Erro ao limpar regras anteriores (admin)." });
      }

      if (regras.length === 0) {
        return res.json({ ok: true, message: "Regras removidas (lista vazia)." });
      }

      const payload = regras.map((r) => ({
        id_quadra: quadraId,
        dia_da_semana: Number(r.dia_da_semana),
        hora_inicio: r.hora_inicio,
        hora_fim: r.hora_fim,
        valor: Number(r.valor || 0),
        criado_por: adminId, // mantém padrão de auditoria/autor
      }));

      // validações básicas iguais ao Gestor
      for (const p of payload) {
        if (![0, 1, 2, 3, 4, 5, 6].includes(p.dia_da_semana)) {
          return res.status(400).json({ error: "dia_da_semana inválido (0..6)." });
        }
        if (!p.hora_inicio || !p.hora_fim) {
          return res.status(400).json({ error: "hora_inicio e hora_fim são obrigatórios." });
        }
        if (Number.isNaN(p.valor)) {
          return res.status(400).json({ error: "valor inválido." });
        }
      }

      const { data: inserted, error: insErr } = await supabase
        .from("regras_horarios")
        .insert(payload)
        .select("id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor");

      if (insErr) {
        console.error("[ADMIN/AGENDA][REGRAS-LOTE][POST] Erro ao inserir regras:", insErr);
        return res.status(500).json({ error: "Erro ao salvar regras (admin)." });
      }

      return res.json({ ok: true, regras: inserted || [] });
    } catch (err) {
      console.error("[ADMIN/AGENDA][REGRAS-LOTE][POST] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/regras/lote." });
    }
  }
);

// -----------------------------------------
// PUT /admin/agenda/regras/:id
// Body: { dia_da_semana, hora_inicio, hora_fim, valor }
// -----------------------------------------
app.put(
  "/admin/agenda/regras/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const regraId = req.params.id;
      const { dia_da_semana, hora_inicio, hora_fim, valor } = req.body || {};

      if (!regraId) {
        return res.status(400).json({ error: "ID da regra é obrigatório." });
      }

      const updatePayload = {};
      if (dia_da_semana !== undefined) updatePayload.dia_da_semana = Number(dia_da_semana);
      if (hora_inicio !== undefined) updatePayload.hora_inicio = hora_inicio;
      if (hora_fim !== undefined) updatePayload.hora_fim = hora_fim;
      if (valor !== undefined) updatePayload.valor = Number(valor);

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Nada para atualizar." });
      }

      if (updatePayload.dia_da_semana !== undefined) {
        if (![0, 1, 2, 3, 4, 5, 6].includes(updatePayload.dia_da_semana)) {
          return res.status(400).json({ error: "dia_da_semana inválido (0..6)." });
        }
      }
      if (updatePayload.valor !== undefined && Number.isNaN(updatePayload.valor)) {
        return res.status(400).json({ error: "valor inválido." });
      }

      // (padrão do Gestor) atualiza e retorna
      // ✅ maybeSingle evita erro quando não encontra registro
      const { data: updated, error: upErr } = await supabase
        .from("regras_horarios")
        .update(updatePayload)
        .eq("id", regraId)
        .select("id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor")
        .maybeSingle();

      if (upErr) {
        console.error("[ADMIN/AGENDA][REGRAS][PUT] Erro ao atualizar regra:", upErr);
        return res.status(500).json({ error: "Erro ao atualizar regra (admin)." });
      }

      if (!updated) {
        return res.status(404).json({ error: "Regra não encontrada." });
      }

      // (extra seguro) valida que a quadra da regra existe (não quebra nada)
      const vr = await adminValidarQuadraExiste(updated.id_quadra);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      return res.json({ ok: true, regra: updated });
    } catch (err) {
      console.error("[ADMIN/AGENDA][REGRAS][PUT] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/regras/:id." });
    }
  }
);


// -----------------------------------------
// DELETE /admin/agenda/regras/:id
// (mesmo padrão do Gestor: hard delete)
// -----------------------------------------
app.delete(
  "/admin/agenda/regras/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const regraId = req.params.id;

      if (!regraId) {
        return res.status(400).json({ error: "ID da regra é obrigatório." });
      }

      const { error: delErr } = await supabase
        .from("regras_horarios")
        .delete()
        .eq("id", regraId);

      if (delErr) {
        console.error("[ADMIN/AGENDA][REGRAS][DELETE] Erro ao deletar regra:", delErr);
        return res.status(500).json({ error: "Erro ao remover regra (admin)." });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("[ADMIN/AGENDA][REGRAS][DELETE] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/regras/:id." });
    }
  }
);


// =========================================
// AGENDA / BLOQUEIOS (PAINEL ADMIN)
// =========================================
// GET    /admin/agenda/bloqueios?quadraId=...&dataInicio=...&dataFim=...
// POST   /admin/agenda/bloqueios/lote
// PUT    /admin/agenda/bloqueios/:id
// DELETE /admin/agenda/bloqueios/:id
//
// Mesmas colunas do Gestor: quadra_id, data, hora_inicio, hora_fim, motivo
// Diferença: Admin valida apenas se a quadra existe (visão global).
// =========================================

// -----------------------------------------
// GET /admin/agenda/bloqueios
// Query: quadraId (obrigatório), dataInicio/opcional, dataFim/opcional
// -----------------------------------------
app.get(
  "/admin/agenda/bloqueios",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { quadraId, dataInicio, dataFim } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /admin/agenda/bloqueios.",
        });
      }

      const vr = await adminValidarQuadraExiste(quadraId);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      // Mesma lógica do Gestor: intervalo opcional
      let query = supabase
        .from("bloqueios_quadra")
        .select("id, quadra_id, data, hora_inicio, hora_fim, motivo")
        .eq("quadra_id", quadraId)
        .order("data", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (dataInicio) query = query.gte("data", String(dataInicio).slice(0, 10));
      if (dataFim) query = query.lte("data", String(dataFim).slice(0, 10));

      const { data, error } = await query;

      if (error) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS][GET] Erro ao buscar bloqueios:", error);
        return res.status(500).json({ error: "Erro ao buscar bloqueios (admin)." });
      }

      return res.json(data || []);
    } catch (err) {
      console.error("[ADMIN/AGENDA][BLOQUEIOS][GET] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/bloqueios." });
    }
  }
);

// -----------------------------------------
// POST /admin/agenda/bloqueios/lote
// Body: { quadraId, bloqueios: [{ data, hora_inicio, hora_fim, motivo }] }
// - Mesmo padrão do Gestor: substitui todos os bloqueios da quadra (hard reset)
// -----------------------------------------
app.post(
  "/admin/agenda/bloqueios/lote",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const adminId = req.usuarioPainel.id;
      const { quadraId, bloqueios } = req.body || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "quadraId é obrigatório em /admin/agenda/bloqueios/lote.",
        });
      }

      const vr = await adminValidarQuadraExiste(quadraId);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      if (!Array.isArray(bloqueios)) {
        return res.status(400).json({
          error: "bloqueios deve ser um array em /admin/agenda/bloqueios/lote.",
        });
      }

      // (padrão do Gestor) remove tudo e insere de novo
      const { error: delErr } = await supabase
        .from("bloqueios_quadra")
        .delete()
        .eq("quadra_id", quadraId);

      if (delErr) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS-LOTE][POST] Erro ao limpar bloqueios:", delErr);
        return res.status(500).json({ error: "Erro ao limpar bloqueios anteriores (admin)." });
      }

      if (bloqueios.length === 0) {
        return res.json({ ok: true, message: "Bloqueios removidos (lista vazia)." });
      }

      const payload = bloqueios.map((b) => ({
        quadra_id: quadraId,
        data: String(b.data).slice(0, 10), // YYYY-MM-DD
        hora_inicio: b.hora_inicio || null,
        hora_fim: b.hora_fim || null,
        motivo: b.motivo || null,
        criado_por: adminId,
      }));

      for (const p of payload) {
        if (!p.data) return res.status(400).json({ error: "data é obrigatória em bloqueios." });

        // se vier faixa, precisa vir completa
        const temIni = !!p.hora_inicio;
        const temFim = !!p.hora_fim;
        if ((temIni && !temFim) || (!temIni && temFim)) {
          return res.status(400).json({
            error: "Para bloqueio por faixa, informe hora_inicio e hora_fim (ambos).",
          });
        }
      }

      const { data: inserted, error: insErr } = await supabase
        .from("bloqueios_quadra")
        .insert(payload)
        .select("id, quadra_id, data, hora_inicio, hora_fim, motivo");

      if (insErr) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS-LOTE][POST] Erro ao inserir bloqueios:", insErr);
        return res.status(500).json({ error: "Erro ao salvar bloqueios (admin)." });
      }

      return res.json({ ok: true, bloqueios: inserted || [] });
    } catch (err) {
      console.error("[ADMIN/AGENDA][BLOQUEIOS-LOTE][POST] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/bloqueios/lote." });
    }
  }
);

// -----------------------------------------
// PUT /admin/agenda/bloqueios/:id
// Body: { data, hora_inicio, hora_fim, motivo }
// -----------------------------------------
app.put(
  "/admin/agenda/bloqueios/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const bloqueioId = req.params.id;
      const { data, hora_inicio, hora_fim, motivo } = req.body || {};

      if (!bloqueioId) {
        return res.status(400).json({ error: "ID do bloqueio é obrigatório." });
      }

      const updatePayload = {};
      if (data !== undefined) updatePayload.data = String(data).slice(0, 10);
      if (hora_inicio !== undefined) updatePayload.hora_inicio = hora_inicio || null;
      if (hora_fim !== undefined) updatePayload.hora_fim = hora_fim || null;
      if (motivo !== undefined) updatePayload.motivo = motivo || null;

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Nada para atualizar." });
      }

      // valida faixa (se vier um, tem que vir os dois)
      const temIni = updatePayload.hora_inicio !== undefined && !!updatePayload.hora_inicio;
      const temFim = updatePayload.hora_fim !== undefined && !!updatePayload.hora_fim;

      // se um foi setado e o outro não foi setado, pode causar inconsistência
      // então buscamos o registro atual para validar o estado final
      const { data: atual, error: getErr } = await supabase
        .from("bloqueios_quadra")
        .select("id, quadra_id, data, hora_inicio, hora_fim, motivo")
        .eq("id", bloqueioId)
        .maybeSingle();

      if (getErr) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS][PUT] Erro ao buscar bloqueio atual:", getErr);
        return res.status(500).json({ error: "Erro ao buscar bloqueio (admin)." });
      }
      if (!atual) {
        return res.status(404).json({ error: "Bloqueio não encontrado." });
      }

      // Admin: garante que quadra existe (extra seguro)
      const vr = await adminValidarQuadraExiste(atual.quadra_id);
      if (!vr.ok) return res.status(vr.status).json({ error: vr.error });

      const horaIniFinal =
        updatePayload.hora_inicio !== undefined ? updatePayload.hora_inicio : atual.hora_inicio;
      const horaFimFinal =
        updatePayload.hora_fim !== undefined ? updatePayload.hora_fim : atual.hora_fim;

      const finalTemIni = !!horaIniFinal;
      const finalTemFim = !!horaFimFinal;

      if ((finalTemIni && !finalTemFim) || (!finalTemIni && finalTemFim)) {
        return res.status(400).json({
          error: "Para bloqueio por faixa, informe hora_inicio e hora_fim (ambos).",
        });
      }

      const { data: updated, error: upErr } = await supabase
        .from("bloqueios_quadra")
        .update(updatePayload)
        .eq("id", bloqueioId)
        .select("id, quadra_id, data, hora_inicio, hora_fim, motivo")
        .single();

      if (upErr) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS][PUT] Erro ao atualizar bloqueio:", upErr);
        return res.status(500).json({ error: "Erro ao atualizar bloqueio (admin)." });
      }

      return res.json({ ok: true, bloqueio: updated });
    } catch (err) {
      console.error("[ADMIN/AGENDA][BLOQUEIOS][PUT] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/bloqueios/:id." });
    }
  }
);

// -----------------------------------------
// DELETE /admin/agenda/bloqueios/:id
// (mesmo padrão do Gestor: hard delete)
// -----------------------------------------
app.delete(
  "/admin/agenda/bloqueios/:id",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const bloqueioId = req.params.id;

      if (!bloqueioId) {
        return res.status(400).json({ error: "ID do bloqueio é obrigatório." });
      }

      const { error: delErr } = await supabase
        .from("bloqueios_quadra")
        .delete()
        .eq("id", bloqueioId);

      if (delErr) {
        console.error("[ADMIN/AGENDA][BLOQUEIOS][DELETE] Erro ao deletar bloqueio:", delErr);
        return res.status(500).json({ error: "Erro ao remover bloqueio (admin)." });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("[ADMIN/AGENDA][BLOQUEIOS][DELETE] Erro geral:", err);
      return res.status(500).json({ error: "Erro interno em /admin/agenda/bloqueios/:id." });
    }
  }
);


// =========================================
// AGENDA / VISÃO DE SLOTS (PAINEL ADMIN) — CLONE DO GESTOR
// =========================================
// GET /admin/agenda/slots
//
// Mesma visão "cinema" do Gestor, porém:
// - Admin pode consultar QUALQUER quadra (global)
// - Única diferença: validação da quadra (existe) em vez de "quadra pertence ao gestor"
//
// Query params:
//   quadraId   (obrigatório)  → UUID da quadra
//   dataInicio (opcional)     → AAAA-MM-DD ou DD/MM/AAAA
//   dataFim    (opcional)     → AAAA-MM-DD ou DD/MM/AAAA
//   filtro     (opcional)     → "disponivel" | "reservada" | "bloqueada" | "todas" (default: "todas")
//
app.get(
  "/admin/agenda/slots",
  authPainel,
  permitirTipos("ADMIN"),
  async (req, res) => {
    try {
      const { quadraId, dataInicio, dataFim, filtro } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /admin/agenda/slots.",
        });
      }

      // 1) Admin: garante apenas que a quadra EXISTE
      const vr = await adminValidarQuadraExiste(quadraId);
      if (!vr.ok) {
        return res.status(vr.status).json({ error: vr.error });
      }

      // 2) Monta intervalo de datas
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      let dtInicio = new Date(hoje.getTime());
      let dtFim = new Date(hoje.getTime());
      dtFim.setDate(dtFim.getDate() + 6); // padrão 7 dias (hoje + 6)

      if (dataInicio) {
        const parsed = parseDataAgendamentoBr(dataInicio);
        if (!parsed) {
          return res.status(400).json({
            error:
              "dataInicio inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /admin/agenda/slots.",
          });
        }
        parsed.setHours(0, 0, 0, 0);
        dtInicio = parsed;
      }

      if (dataFim) {
        const parsed = parseDataAgendamentoBr(dataFim);
        if (!parsed) {
          return res.status(400).json({
            error:
              "dataFim inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /admin/agenda/slots.",
          });
        }
        parsed.setHours(0, 0, 0, 0);
        dtFim = parsed;
      }

      if (dtFim < dtInicio) {
        return res.status(400).json({
          error:
            "dataFim não pode ser menor que dataInicio em /admin/agenda/slots.",
        });
      }

      // Protege contra intervalos muito grandes (máx. 60 dias)
      const diffMs = dtFim.getTime() - dtInicio.getTime();
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDias > 60) {
        return res.status(400).json({
          error: "Intervalo máximo permitido é de 60 dias em /admin/agenda/slots.",
        });
      }

      const dataInicioISO = formatDateISO(dtInicio);
      const dataFimISO = formatDateISO(dtFim);

      // 3) Busca REGRAS de horário da quadra (recorrentes por dia_da_semana)
      const { data: regras, error: errRegras } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor
        `
        )
        .eq("id_quadra", quadraId);

      if (errRegras) {
        console.error(
          "[ADMIN/AGENDA/SLOTS][GET] Erro ao buscar regras_horarios:",
          errRegras
        );
        return res.status(500).json({
          error: "Erro ao buscar regras de horário em /admin/agenda/slots.",
        });
      }

      const regrasList = regras || [];

      // Mapa por dia_da_semana (0=Domingo ... 6=Sábado)
      const regrasPorDiaSemana = new Map();
      for (const r of regrasList) {
        const key = r.dia_da_semana;
        if (!regrasPorDiaSemana.has(key)) {
          regrasPorDiaSemana.set(key, []);
        }
        regrasPorDiaSemana.get(key).push(r);
      }

      // 4) Busca RESERVAS no período (pending/paid)
      const { data: reservas, error: errReservas } = await supabase
        .from("reservas")
        .select(
          `
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total,
          user_cpf,
          phone
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO)
        .in("status", ["pending", "paid", "pendente", "pago"]);

      if (errReservas) {
        console.error(
          "[ADMIN/AGENDA/SLOTS][GET] Erro ao buscar reservas:",
          errReservas
        );
        return res.status(500).json({
          error: "Erro ao buscar reservas em /admin/agenda/slots.",
        });
      }

      const reservasList = reservas || [];

      // Mapa chave "YYYY-MM-DD|HH:MM" -> reserva
      const reservasPorChave = new Map();
      for (const r of reservasList) {
        const dataStr = String(r.data).slice(0, 10);
        const horaStr = String(r.hora).slice(0, 5); // HH:MM
        const key = `${dataStr}|${horaStr}`;
        reservasPorChave.set(key, r);
      }

      // 5) Busca BLOQUEIOS no período
      const { data: bloqueios, error: errBloqueios } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", dataInicioISO)
        .lte("data", dataFimISO);

      if (errBloqueios) {
        console.error(
          "[ADMIN/AGENDA/SLOTS][GET] Erro ao buscar bloqueios_quadra:",
          errBloqueios
        );
        return res.status(500).json({
          error: "Erro ao buscar bloqueios em /admin/agenda/slots.",
        });
      }

      const bloqueiosList = bloqueios || [];

      // Mapa por data "YYYY-MM-DD" -> lista de bloqueios
      const bloqueiosPorData = new Map();
      for (const b of bloqueiosList) {
        const dataStr = String(b.data).slice(0, 10);
        if (!bloqueiosPorData.has(dataStr)) {
          bloqueiosPorData.set(dataStr, []);
        }
        bloqueiosPorData.get(dataStr).push(b);
      }

      // 6) Filtro de status para resposta
      const filtroNorm = String(filtro || "todas").toLowerCase();
      const filtroValido = ["todas", "disponivel", "reservada", "bloqueada"];
      const filtroFinal = filtroValido.includes(filtroNorm) ? filtroNorm : "todas";

      // 7) Gera lista de datas do intervalo
      const dias = [];
      const dtCursor = new Date(dtInicio.getTime());
      while (dtCursor.getTime() <= dtFim.getTime()) {
        const iso = dtCursor.toISOString().slice(0, 10); // YYYY-MM-DD
        const weekday = dtCursor.getDay(); // 0=Domingo ... 6=Sábado

        const regrasDoDia = regrasPorDiaSemana.get(weekday) || [];
        const bloqueiosDoDia = bloqueiosPorData.get(iso) || [];

        const slotsDia = [];

        for (const regra of regrasDoDia) {
          // Para cada regra (ex.: 18:00–23:00), gera slots de 1h
          let slotsRegra = [];
          try {
            slotsRegra = gerarSlotsHoraCheia(regra.hora_inicio, regra.hora_fim);
          } catch (e) {
            console.error(
              "[ADMIN/AGENDA/SLOTS][GET] Erro ao gerar slots para regra:",
              regra,
              e
            );
            continue;
          }

          for (const slot of slotsRegra) {
            const horaInicioSlot = slot.hora_inicio; // HH:MM
            const horaFimSlot = slot.hora_fim;       // HH:MM

            // Verifica bloqueio (prioridade sobre reserva)
            let statusSlot = "DISPONIVEL";
            let reservaInfo = null;
            let bloqueioInfo = null;

            // 7.1) Checa bloqueio
            if (bloqueiosDoDia.length > 0) {
              for (const b of bloqueiosDoDia) {
                const bHoraInicio = b.hora_inicio;
                const bHoraFim = b.hora_fim;

                // Caso especial: bloqueio de dia inteiro (sem horas)
                if (!bHoraInicio && !bHoraFim) {
                  statusSlot = "BLOQUEADO";
                  bloqueioInfo = {
                    id: b.id,
                    motivo: b.motivo,
                    tipo: "DIA_INTEIRO",
                  };
                  break;
                }

                // Bloqueio com faixa de horário
                if (bHoraInicio && bHoraFim) {
                  const [bhIni, bmIni] = String(bHoraInicio)
                    .slice(0, 5)
                    .split(":")
                    .map((n) => Number(n));
                  const [bhFim, bmFim] = String(bHoraFim)
                    .slice(0, 5)
                    .split(":")
                    .map((n) => Number(n));

                  const [shIni, smIni] = horaInicioSlot
                    .split(":")
                    .map((n) => Number(n));

                  const slotMin = shIni * 60 + smIni;
                  const bIniMin = bhIni * 60 + bmIni;
                  const bFimMin = bhFim * 60 + bmFim;

                  // Se o início do slot está dentro da faixa de bloqueio → BLOQUEADO
                  if (slotMin >= bIniMin && slotMin < bFimMin) {
                    statusSlot = "BLOQUEADO";
                    bloqueioInfo = {
                      id: b.id,
                      motivo: b.motivo,
                      tipo: "FAIXA_HORARIO",
                    };
                    break;
                  }
                }
              }
            }

            // 7.2) Se NÃO estiver bloqueado, checa reserva
            if (statusSlot !== "BLOQUEADO") {
              const chave = `${iso}|${horaInicioSlot}`;
              const r = reservasPorChave.get(chave);
              if (r) {
                statusSlot = "RESERVADO";
                reservaInfo = {
                  id: r.id,
                  status: r.status,
                  preco_total: Number(r.preco_total || 0),
                  user_cpf: r.user_cpf,
                  phone: r.phone,
                };
              }
            }

            // 7.3) Aplica filtro de status
            const statusLower = statusSlot.toLowerCase(); // disponivel | reservado | bloqueado
            if (
              filtroFinal !== "todas" &&
              !(
                (filtroFinal === "disponivel" && statusLower === "disponivel") ||
                (filtroFinal === "reservada" && statusLower === "reservado") ||
                (filtroFinal === "bloqueada" && statusLower === "bloqueado")
              )
            ) {
              continue;
            }

            slotsDia.push({
              data: iso,
              hora_inicio: horaInicioSlot,
              hora_fim: horaFimSlot,
              status: statusSlot,
              reserva: reservaInfo,
              bloqueio: bloqueioInfo,
              preco_hora: Number(regra.valor || 0),
              regra_id: regra.id,
            });
          }
        }

        dias.push({
          data: iso,
          dia_semana: weekday,
          slots: slotsDia,
        });

        dtCursor.setDate(dtCursor.getDate() + 1);
      }

      return res.json({
        quadra_id: quadraId,
        data_inicio: dataInicioISO,
        data_fim: dataFimISO,
        filtro: filtroFinal,
        dias,
      });
    } catch (err) {
      console.error("[ADMIN/AGENDA/SLOTS][GET] Erro geral:", err);
      return res.status(500).json({
        error: "Erro interno em /admin/agenda/slots.",
      });
    }
  }
);


// -----------------------------------------
// GET /gestor/reservas/grade  → visão "cinema" da agenda
// Query params:
//   - quadraId   (obrigatório)
//   - dataInicio (opcional, YYYY-MM-DD) → se não vier, assume hoje
//   - dataFim    (opcional, YYYY-MM-DD) → se não vier, assume dataInicio + 6 dias
//   - filtro     (opcional: 'disponiveis' | 'reservadas' | 'bloqueadas' | 'todas')
// -----------------------------------------
app.get(
  "/gestor/reservas/grade",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId, dataInicio, dataFim, filtro } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error:
            "Parâmetro quadraId é obrigatório em /gestor/reservas/grade.",
        });
      }

      // Garante que a quadra realmente pertence ao gestor logado
      await validarQuadraDoGestor(quadraId, gestorId);

      // -------------------------------------
      // Monta intervalo de datas (default = hoje + 6 dias)
      // -------------------------------------
      const hoje = new Date();
      const normalizarData = (d) => {
        // força horário meio-dia pra evitar problema de fuso no toISOString()
        const dt = new Date(d);
        dt.setHours(12, 0, 0, 0);
        return dt;
      };

            let inicioDate = dataInicio
        ? normalizarData(dataInicio)
        : normalizarData(hoje);

      let fimDate;

      if (dataFim) {
        // Se o front mandar dataFim, respeitamos
        fimDate = normalizarData(dataFim);
      } else {
        // Se não passar dataFim, mostra 7 dias (0..6) → hoje + 6
        fimDate = new Date(inicioDate.getTime());
        fimDate.setDate(fimDate.getDate() + 6);
      }

      // Valida ordem das datas
      if (fimDate < inicioDate) {
        return res.status(400).json({
          error:
            "dataFim não pode ser anterior a dataInicio em /gestor/reservas/grade.",
        });
      }

      // 🔒 Proteção: intervalo máximo de 60 dias
      const diffMs = fimDate.getTime() - inicioDate.getTime();
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDias > 60) {
        return res.status(400).json({
          error:
            "Intervalo máximo permitido é de 60 dias em /gestor/reservas/grade.",
        });
      }

      // Gera lista de dias entre inicioDate e fimDate (inclusive)
      const diasIntervalo = [];

      const iter = new Date(inicioDate.getTime());
      while (iter <= fimDate) {
        const isoData = iter.toISOString().slice(0, 10); // YYYY-MM-DD
        const diaSemana = iter.getDay(); // 0=Domingo ... 6=Sábado
        diasIntervalo.push({ data: isoData, diaSemana });
        iter.setDate(iter.getDate() + 1);
      }

      const datasApenas = diasIntervalo.map((d) => d.data);

      // -------------------------------------
      // 1) Busca regras de horário da quadra
      // -------------------------------------
      const { data: regras, error: erroRegras } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor
        `
        )
        .eq("id_quadra", quadraId);

      if (erroRegras) {
        console.error(
          "[GESTOR/RESERVAS/GRADE] Erro ao buscar regras_horarios:",
          erroRegras
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar regras de horário da quadra." });
      }

      const regrasLista = regras || [];

      // -------------------------------------
      // 2) Busca reservas da quadra no intervalo
      // -------------------------------------
      const { data: reservas, error: erroReservas } = await supabase
  .from("reservas")
  .select(
    `
    id,
    quadra_id,
    data,
    hora,
    user_cpf,
    phone,
    preco_total,
    status,
    origem
  `
  )
  .eq("quadra_id", quadraId)
  .in("data", datasApenas);


      if (erroReservas) {
        console.error(
          "[GESTOR/RESERVAS/GRADE] Erro ao buscar reservas:",
          erroReservas
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar reservas da quadra." });
      }

            // Considera apenas reservas que realmente ocupam o horário:
      // - pending ou paid = bloqueiam o slot
      // - canceled = não entra no mapa (libera o slot)
      const reservasLista = (reservas || []).filter((r) => {
        if (!r.status) return false;
        const st = r.status.toString().toLowerCase().trim();
        return st === "pending" || st === "paid";
      });

      // Mapa rápido de reservas por (data + hora_inicio)
      const reservasPorDataHora = new Map();
      for (const r of reservasLista) {
        // hora pode vir como 'HH:MM:SS' → normalizamos para 'HH:MM'
        const horaStr = (r.hora || "").toString();
        const horaCurta = horaStr.slice(0, 5); // '18:00:00' → '18:00'

        // chave tipo '2025-12-10T18:00'
        const chave = `${r.data}T${horaCurta}`;
        reservasPorDataHora.set(chave, r);
      }

      // -------------------------------------


      // -------------------------------------
      // 3) Busca bloqueios da quadra no intervalo
      // -------------------------------------
      const { data: bloqueios, error: erroBloqueios } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `
        )
        .eq("quadra_id", quadraId)
        .in("data", datasApenas);

      if (erroBloqueios) {
        console.error(
          "[GESTOR/RESERVAS/GRADE] Erro ao buscar bloqueios_quadra:",
          erroBloqueios
        );
        return res
          .status(500)
          .json({ error: "Erro ao buscar bloqueios da quadra." });
      }

      const bloqueiosLista = bloqueios || [];

      // Mapa de bloqueios por data (cada data → array de bloqueios)
      const bloqueiosPorData = new Map();
      for (const b of bloqueiosLista) {
        if (!bloqueiosPorData.has(b.data)) {
          bloqueiosPorData.set(b.data, []);
        }
        bloqueiosPorData.get(b.data).push(b);
      }

      // helper pra comparar strings de horário HH:MM:SS
      const horaMenorOuIgual = (a, b) => a <= b;
      const horaMaiorOuIgual = (a, b) => a >= b;

      // helper: verifica se um slot (hora_inicio/hora_fim) cai em algum bloqueio naquele dia
      function encontrarBloqueioParaSlot(dataISO, slotInicio, slotFim) {
        const lista = bloqueiosPorData.get(dataISO);
        if (!lista || lista.length === 0) return null;

        // Consideramos "overlap" se tiver interseção no intervalo
        // (slotInicio < bloqueio.hora_fim && slotFim > bloqueio.hora_inicio)
        return (
          lista.find((b) => {
            const bInicio = b.hora_inicio;
            const bFim = b.hora_fim;

            const cond1 = slotInicio < bFim;
            const cond2 = slotFim > bInicio;
            return cond1 && cond2;
          }) || null
        );
      }

      // Normaliza filtro
      const filtroNorm =
        (filtro || "todas").toString().trim().toLowerCase(); // todas, disponiveis, reservadas, bloqueadas

      // -------------------------------------
      // Monta a grade final
      // -------------------------------------
      const grade = [];

      for (const dia of diasIntervalo) {
        const { data: dataISO, diaSemana } = dia;

        // regras daquele dia da semana
        const regrasDoDia = regrasLista.filter(
          (r) => Number(r.dia_da_semana) === Number(diaSemana)
        );

        const slotsDia = [];

        for (const regra of regrasDoDia) {
          // Gera slots de 1h dentro da regra
          let slotsRegra;
          try {
            slotsRegra = gerarSlotsHoraCheia(
              regra.hora_inicio,
              regra.hora_fim
            );
          } catch (e) {
            console.error(
              "[GESTOR/RESERVAS/GRADE] Erro em gerarSlotsHoraCheia:",
              e
            );
            // pulo essa regra problemática, mas continuo as demais
            continue;
          }

          for (const slot of slotsRegra) {
            const slotInicio = slot.hora_inicio; // 'HH:MM'
            // Aqui considero hora_fim exata do slot
            const slotFim = slot.hora_fim; // 'HH:MM'

            // Reserva: chave = data + 'T' + hora_inicio
            // Importante: no Postgres time costuma vir 'HH:MM:SS'
            // então aqui assumo que r.hora (reservas.hora) tem o mesmo padrão de hora_inicio
            const chaveReserva = `${dataISO}T${slotInicio}`;
            const reserva = reservasPorDataHora.get(chaveReserva) || null;

            // Bloqueio: qualquer bloqueio que interseccione esse intervalo
            const bloqueio = encontrarBloqueioParaSlot(
              dataISO,
              slotInicio,
              slotFim
            );

            let status = "disponivel"; // default = verde
            if (bloqueio) {
              status = "bloqueado"; // cinza
            } else if (reserva) {
              status = "reservado"; // vermelho
            }

            // Aplica filtro, se houver
            const statusFiltro =
              status === "disponivel"
                ? "disponiveis"
                : status === "reservado"
                ? "reservadas"
                : "bloqueadas";

            if (
              filtroNorm !== "todas" &&
              filtroNorm !== statusFiltro
            ) {
              continue;
            }

            // Sugerimos cor aqui, mas o front decide o CSS
            let cor = "verde";
            if (status === "reservado") cor = "vermelho";
            if (status === "bloqueado") cor = "cinza";

            slotsDia.push({
              data: dataISO,
              dia_semana: diaSemana,
              hora_inicio: slotInicio,
              hora_fim: slotFim,
              preco_hora: regra.valor,
              status, // 'disponivel' | 'reservado' | 'bloqueado'
              cor, // 'verde' | 'vermelho' | 'cinza'
              reserva, // objeto da tabela reservas (se existir)
              bloqueio, // objeto da tabela bloqueios_quadra (se existir)
            });
          }
        }

        grade.push({
          data: dataISO,
          dia_semana: diaSemana,
          slots: slotsDia,
        });
      }

      return res.json({
        quadraId,
        dataInicio: diasIntervalo[0]?.data || null,
        dataFim: diasIntervalo[diasIntervalo.length - 1]?.data || null,
        filtro: filtroNorm,
        grade,
      });
    } catch (err) {
      console.error("[GESTOR/RESERVAS/GRADE] Erro geral:", err);

      if (err.message === "Quadra não pertence a este gestor") {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === "Quadra não encontrada") {
        return res.status(404).json({ error: err.message });
      }

      return res
        .status(500)
        .json({ error: "Erro interno ao montar grade de reservas." });
    }
  }
);
// ==========================================================
// MÓDULO FINANCEIRO (Pagamentos + Repasses)
// - Usa tabelas existentes: pagamentos, repasses, repasses_pagamentos
// - authPainel + req.user.id
// ==========================================================

// ---------- helpers ----------
function parseDateISO(s) {
  // aceita "YYYY-MM-DD"
  if (!s || typeof s !== "string") return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  return ok ? s : null;
}

function defaultPeriodo() {
  // últimos 30 dias
  const fim = new Date();
  const ini = new Date();
  ini.setDate(ini.getDate() - 30);
  const toISO = (d) => d.toISOString().slice(0, 10);
  return { inicio: toISO(ini), fim: toISO(fim) };
}

function round2(v) {
  const n = Number(v || 0);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Busca todas as quadras do gestor
async function getQuadraIdsDoGestor(gestorId) {
  const { data, error } = await supabase
    .from("quadras")
    .select("id")
    .eq("gestor_id", gestorId);

  if (error) throw error;
  return (data || []).map((x) => x.id);
}

// Busca reservas do gestor (por período opcional)
async function getReservaIdsDoGestor(quadraIds, inicio, fim) {
  if (!quadraIds || quadraIds.length === 0) return [];

  let q = supabase
    .from("reservas")
    .select("id")
    .in("quadra_id", quadraIds);

  // se seu schema usa outra coluna de data/hora, ajuste aqui.
  // (você já usa reservas.data e reservas.hora no webhook)
  if (inicio) q = q.gte("data", inicio);
  if (fim) q = q.lte("data", fim);

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((x) => x.id);
}

// Busca pagamentos por lista de reservas (com paginação simples)
async function getPagamentosByReservaIds(reservaIds, opts = {}) {
  const { inicio, fim, status, limit = 2000, offset = 0 } = opts;

  if (!reservaIds || reservaIds.length === 0) return [];

  let q = supabase
    .from("pagamentos")
    .select(
      `
      id,
      reserva_id,
      valor_total,
      taxa_plataforma,
      valor_liquido_gestor,
      status,
      meio_pagamento,
      mp_payment_id,
      created_at,
      updated_at
      `
    )
    .in("reserva_id", reservaIds)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getPagamentosIdsJaRepassados(pagamentoIds) {
  if (!pagamentoIds || pagamentoIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("repasses_pagamentos")
    .select("pagamento_id")
    .in("pagamento_id", pagamentoIds);

  if (error) throw error;

  const set = new Set();
  (data || []).forEach((x) => set.add(x.pagamento_id));
  return set;
}

// Guardas “não quebráveis”: se não existir tipo/role, não bloqueia.
// Você pode endurecer depois.
function requireAdminSoft(req, res) {
  const t = req.user?.tipo || req.user?.role || req.user?.perfil;
  if (!t) return true; // não bloqueia se você não setou isso no token
  const ok = String(t).toUpperCase().includes("ADMIN");
  if (!ok) {
    res.status(403).json({ error: "Acesso restrito ao ADMIN." });
    return false;
  }
  return true;
}

// ==========================================================
// (1) GESTOR — RESUMO FINANCEIRO
// GET /gestor/financeiro/resumo?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&status=paid
// ==========================================================
app.get("/gestor/financeiro/resumo", authPainel, permitirTipos("GESTOR"), async (req, res) => {
  try {
    // ✅ PADRÃO DO SEU PROJETO: authPainel -> req.usuarioPainel
    const gestorId = req.usuarioPainel?.id;

    const def = defaultPeriodo();
    const inicio = parseDateISO(req.query.inicio) || def.inicio;
    const fim = parseDateISO(req.query.fim) || def.fim;
    const status = req.query.status || "paid";

    const quadraIds = await getQuadraIdsDoGestor(gestorId);
    const reservaIds = await getReservaIdsDoGestor(quadraIds, inicio, fim);
    const pagamentos = await getPagamentosByReservaIds(reservaIds, {
      status,
      limit: 2000,
      offset: 0
    });

    const total_bruto = round2(pagamentos.reduce((a, p) => a + Number(p.valor_total || 0), 0));
    const total_taxa = round2(pagamentos.reduce((a, p) => a + Number(p.taxa_plataforma || 0), 0));
    const total_liquido = round2(pagamentos.reduce((a, p) => a + Number(p.valor_liquido_gestor || 0), 0));

    const pagamentoIds = pagamentos.map((p) => p.id);
    const setRepassados = await getPagamentosIdsJaRepassados(pagamentoIds);

    const repassados_count = pagamentoIds.filter((id) => setRepassados.has(id)).length;
    const pendentes_repasse_count = pagamentoIds.length - repassados_count;

    return res.json({
      periodo: { inicio, fim },
      status,
      qtd_pagamentos: pagamentos.length,
      total_bruto,
      total_taxa,
      total_liquido,
      repassados_count,
      pendentes_repasse_count
    });
  } catch (err) {
    console.error("[GESTOR/FINANCEIRO] Erro em /gestor/financeiro/resumo:", err);
    return res.status(500).json({ error: "Erro ao calcular resumo financeiro do gestor." });
  }
});

// ==========================================================
// (2) GESTOR — LISTA DE PAGAMENTOS (com repassado/pending repasse)
// GET /gestor/financeiro/pagamentos?inicio&fim&status&pagina&limite
// ==========================================================
app.get("/gestor/financeiro/pagamentos", authPainel, permitirTipos("GESTOR"), async (req, res) => {
  try {
    // ✅ PADRÃO DO SEU PROJETO: authPainel -> req.usuarioPainel
    const gestorId = req.usuarioPainel?.id;

    const def = defaultPeriodo();
    const inicio = parseDateISO(req.query.inicio) || def.inicio;
    const fim = parseDateISO(req.query.fim) || def.fim;
    const status = req.query.status || "paid";

    const pagina = Math.max(1, Number(req.query.pagina || 1));
    const limite = Math.min(2000, Math.max(10, Number(req.query.limite || 200)));
    const offset = (pagina - 1) * limite;

    const quadraIds = await getQuadraIdsDoGestor(gestorId);
    const reservaIds = await getReservaIdsDoGestor(quadraIds, inicio, fim);

    const pagamentos = await getPagamentosByReservaIds(reservaIds, {
      status,
      limit: limite,
      offset
    });

    const pagamentoIds = pagamentos.map((p) => p.id);
    const setRepassados = await getPagamentosIdsJaRepassados(pagamentoIds);

    const itens = pagamentos.map((p) => ({
      ...p, // ✅ corrigido (antes estava ".p" no seu arquivo)
      repassado: setRepassados.has(p.id)
    }));

    return res.json({
      periodo: { inicio, fim },
      status,
      pagina,
      limite,
      itens
    });
  } catch (err) {
    console.error("[GESTOR/FINANCEIRO] Erro em /gestor/financeiro/pagamentos:", err);
    return res.status(500).json({ error: "Erro ao listar pagamentos do gestor." });
  }
});


// ==========================================================
// (3) GESTOR — LISTA DE REPASSES
// GET /gestor/financeiro/repasses?ano=2025&mes=12&status=pendente|pago
// ==========================================================
app.get("/gestor/financeiro/repasses", authPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;

    let q = supabase
      .from("repasses")
      .select(
        `
        id,
        gestor_id,
        competencia_mes,
        competencia_ano,
        total_bruto,
        total_taxa,
        total_liquido,
        status,
        data_pagamento,
        observacao,
        created_at
        `
      )
      .eq("gestor_id", gestorId)
      .order("competencia_ano", { ascending: false })
      .order("competencia_mes", { ascending: false });

    if (req.query.ano) q = q.eq("competencia_ano", Number(req.query.ano));
    if (req.query.mes) q = q.eq("competencia_mes", Number(req.query.mes));
    if (req.query.status) q = q.eq("status", String(req.query.status));

    const { data, error } = await q;
    if (error) {
      console.error("[GESTOR/FINANCEIRO] Erro ao buscar repasses:", error);
      return res.status(500).json({ error: "Erro ao buscar repasses do gestor." });
    }

    return res.json({ itens: data || [] });
  } catch (err) {
    console.error("[GESTOR/FINANCEIRO] Erro em /gestor/financeiro/repasses:", err);
    return res.status(500).json({ error: "Erro ao listar repasses do gestor." });
  }
});

// ==========================================================
// (4) ADMIN — RESUMO FINANCEIRO GLOBAL
// GET /admin/financeiro/resumo?inicio&fim&status=paid
// ==========================================================
app.get("/admin/financeiro/resumo", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const def = defaultPeriodo();
    const inicio = parseDateISO(req.query.inicio) || def.inicio;
    const fim = parseDateISO(req.query.fim) || def.fim;
    const status = req.query.status || "paid";

    // Pegamos pagamentos por período usando created_at (mais “financeiro”)
    let q = supabase
      .from("pagamentos")
      .select("id, valor_total, taxa_plataforma, valor_liquido_gestor, status, created_at")
      .order("created_at", { ascending: false });

    if (status) q = q.eq("status", status);
    if (inicio) q = q.gte("created_at", `${inicio}T00:00:00.000Z`);
    if (fim) q = q.lte("created_at", `${fim}T23:59:59.999Z`);

    const { data: pagamentos, error } = await q;
    if (error) {
      console.error("[ADMIN/FINANCEIRO] Erro ao buscar pagamentos:", error);
      return res.status(500).json({ error: "Erro ao buscar pagamentos do período." });
    }

    const total_bruto = round2((pagamentos || []).reduce((a, p) => a + Number(p.valor_total || 0), 0));
    const total_taxa = round2((pagamentos || []).reduce((a, p) => a + Number(p.taxa_plataforma || 0), 0));
    const total_liquido = round2(
      (pagamentos || []).reduce((a, p) => a + Number(p.valor_liquido_gestor || 0), 0)
    );

    // pendente de repasse = pagamentos paid que não estão em repasses_pagamentos
    const ids = (pagamentos || []).map((p) => p.id);
    const setRepassados = await getPagamentosIdsJaRepassados(ids);
    const pendentes_repasse = ids.filter((id) => !setRepassados.has(id)).length;

    // repasses do período (por competência fica melhor, mas aqui só uma visão geral)
    const { data: repasses, error: repErr } = await supabase
      .from("repasses")
      .select("id, status, total_liquido")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (repErr) console.warn("[ADMIN/FINANCEIRO] Aviso ao buscar repasses:", repErr);

    const repasses_pendentes = (repasses || []).filter((r) => String(r.status) === "pendente").length;
    const repasses_pagos = (repasses || []).filter((r) => String(r.status) !== "pendente").length;

    return res.json({
      periodo: { inicio, fim },
      status,
      qtd_pagamentos: (pagamentos || []).length,
      total_bruto,
      total_taxa,
      total_liquido,
      pendentes_repasse,
      repasses_pendentes,
      repasses_pagos
    });
  } catch (err) {
    console.error("[ADMIN/FINANCEIRO] Erro em /admin/financeiro/resumo:", err);
    return res.status(500).json({ error: "Erro ao calcular resumo financeiro do admin." });
  }
});

// ==========================================================
// (5) ADMIN — VISÃO POR GESTOR (consolidado simples)
// GET /admin/financeiro/gestores?inicio&fim&status=paid
// ==========================================================
app.get("/admin/financeiro/gestores", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const def = defaultPeriodo();
    const inicio = parseDateISO(req.query.inicio) || def.inicio;
    const fim = parseDateISO(req.query.fim) || def.fim;
    const status = req.query.status || "paid";

    // Estratégia segura sem join avançado:
    // - Para cada gestor: pega quadras -> reservas -> pagamentos -> soma.
    const { data: gestores, error: gErr } = await supabase
      .from("gestores")
      .select("id, nome, email")
      .order("nome", { ascending: true });

    if (gErr) {
      console.error("[ADMIN/FINANCEIRO] Erro ao buscar gestores:", gErr);
      return res.status(500).json({ error: "Erro ao buscar gestores." });
    }

    const itens = [];
    for (const g of gestores || []) {
      const quadraIds = await getQuadraIdsDoGestor(g.id);
      const reservaIds = await getReservaIdsDoGestor(quadraIds, inicio, fim);
      const pagamentos = await getPagamentosByReservaIds(reservaIds, {
        status,
        limit: 2000,
        offset: 0
      });

      const total_bruto = round2(pagamentos.reduce((a, p) => a + Number(p.valor_total || 0), 0));
      const total_taxa = round2(pagamentos.reduce((a, p) => a + Number(p.taxa_plataforma || 0), 0));
      const total_liquido = round2(
        pagamentos.reduce((a, p) => a + Number(p.valor_liquido_gestor || 0), 0)
      );

      const ids = pagamentos.map((p) => p.id);
      const setRepassados = await getPagamentosIdsJaRepassados(ids);
      const pendentes_repasse = ids.filter((id) => !setRepassados.has(id)).length;

      itens.push({
        gestor: { id: g.id, nome: g.nome, email: g.email },
        qtd_pagamentos: pagamentos.length,
        total_bruto,
        total_taxa,
        total_liquido,
        pendentes_repasse
      });
    }

    return res.json({ periodo: { inicio, fim }, status, itens });
  } catch (err) {
    console.error("[ADMIN/FINANCEIRO] Erro em /admin/financeiro/gestores:", err);
    return res.status(500).json({ error: "Erro ao consolidar financeiro por gestor." });
  }
});

// ==========================================================
// (6) ADMIN — LISTAR PAGAMENTOS ELEGÍVEIS PARA REPASSE
// GET /admin/repasses/eligiveis?gestorId=UUID&inicio&fim
// Retorna pagamentos paid do gestor no período que NÃO estão em repasses_pagamentos
// ==========================================================
app.get("/admin/repasses/eligiveis", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const gestorId = req.query.gestorId;
    if (!gestorId) return res.status(400).json({ error: "gestorId é obrigatório." });

    const def = defaultPeriodo();
    const inicio = parseDateISO(req.query.inicio) || def.inicio;
    const fim = parseDateISO(req.query.fim) || def.fim;

    const quadraIds = await getQuadraIdsDoGestor(gestorId);
    const reservaIds = await getReservaIdsDoGestor(quadraIds, inicio, fim);

    const pagamentos = await getPagamentosByReservaIds(reservaIds, {
      status: "paid",
      limit: 2000,
      offset: 0
    });

    const ids = pagamentos.map((p) => p.id);
    const setRepassados = await getPagamentosIdsJaRepassados(ids);

    const elegiveis = pagamentos.filter((p) => !setRepassados.has(p.id));

    return res.json({ periodo: { inicio, fim }, gestorId, itens: elegiveis });
  } catch (err) {
    console.error("[ADMIN/REPASSES] Erro em /admin/repasses/eligiveis:", err);
    return res.status(500).json({ error: "Erro ao listar pagamentos elegíveis para repasse." });
  }
});

// ==========================================================
// (7) ADMIN — CRIAR REPASSE (manual)
// POST /admin/repasses
// body: { gestor_id, competencia_mes, competencia_ano, inicio?, fim?, observacao?, vincular_todos? }
// - Cria repasse pendente e (opcional) já vincula todos pagamentos elegíveis do período.
// ==========================================================
app.post("/admin/repasses", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const {
      gestor_id,
      competencia_mes,
      competencia_ano,
      inicio,
      fim,
      observacao,
      vincular_todos
    } = req.body || {};

    if (!gestor_id) return res.status(400).json({ error: "gestor_id é obrigatório." });
    if (!competencia_mes || !competencia_ano) {
      return res.status(400).json({ error: "competencia_mes e competencia_ano são obrigatórios." });
    }

    const def = defaultPeriodo();
    const ini = parseDateISO(inicio) || def.inicio;
    const fi = parseDateISO(fim) || def.fim;

    // pega elegíveis do período
    const quadraIds = await getQuadraIdsDoGestor(gestor_id);
    const reservaIds = await getReservaIdsDoGestor(quadraIds, ini, fi);
    const pagamentos = await getPagamentosByReservaIds(reservaIds, { status: "paid", limit: 2000, offset: 0 });

    const ids = pagamentos.map((p) => p.id);
    const setRepassados = await getPagamentosIdsJaRepassados(ids);
    const elegiveis = pagamentos.filter((p) => !setRepassados.has(p.id));

    const total_bruto = round2(elegiveis.reduce((a, p) => a + Number(p.valor_total || 0), 0));
    const total_taxa = round2(elegiveis.reduce((a, p) => a + Number(p.taxa_plataforma || 0), 0));
    const total_liquido = round2(elegiveis.reduce((a, p) => a + Number(p.valor_liquido_gestor || 0), 0));

    const { data: repasseCriado, error: repErr } = await supabase
      .from("repasses")
      .insert([
        {
          gestor_id,
          competencia_mes: Number(competencia_mes),
          competencia_ano: Number(competencia_ano),
          total_bruto,
          total_taxa,
          total_liquido,
          status: "pendente",
          data_pagamento: null,
          observacao: observacao || null
        }
      ])
      .select("id, gestor_id, competencia_mes, competencia_ano, total_bruto, total_taxa, total_liquido, status, data_pagamento, observacao, created_at")
      .single();

    if (repErr) {
      console.error("[ADMIN/REPASSES] Erro ao criar repasse:", repErr);
      return res.status(500).json({ error: "Erro ao criar repasse." });
    }

    // vincula automaticamente (se solicitado)
    if (vincular_todos) {
      const links = elegiveis.map((p) => ({
        repasse_id: repasseCriado.id,
        pagamento_id: p.id
      }));

      if (links.length > 0) {
        const { error: linkErr } = await supabase
          .from("repasses_pagamentos")
          .insert(links);

        if (linkErr) {
          console.error("[ADMIN/REPASSES] Erro ao vincular pagamentos ao repasse:", linkErr);
          // não aborta o repasse; apenas informa
          return res.json({
            repasse: repasseCriado,
            aviso: "Repasse criado, mas falhou ao vincular pagamentos automaticamente.",
            qtd_elegiveis: elegiveis.length
          });
        }
      }
    }

    return res.json({
      repasse: repasseCriado,
      periodo: { inicio: ini, fim: fi },
      qtd_elegiveis: elegiveis.length
    });
  } catch (err) {
    console.error("[ADMIN/REPASSES] Erro em POST /admin/repasses:", err);
    return res.status(500).json({ error: "Erro inesperado ao criar repasse." });
  }
});

// ==========================================================
// (8) ADMIN — VINCULAR PAGAMENTOS A UM REPASSE
// POST /admin/repasses/:repasseId/vincular
// body: { pagamento_ids: [uuid, uuid, ...] }
// ==========================================================
app.post("/admin/repasses/:repasseId/vincular", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const repasseId = req.params.repasseId;
    const { pagamento_ids } = req.body || {};

    if (!repasseId) return res.status(400).json({ error: "repasseId é obrigatório." });
    if (!Array.isArray(pagamento_ids) || pagamento_ids.length === 0) {
      return res.status(400).json({ error: "pagamento_ids deve ser um array não vazio." });
    }

    const links = pagamento_ids.map((pid) => ({
      repasse_id: repasseId,
      pagamento_id: pid
    }));

    const { error } = await supabase.from("repasses_pagamentos").insert(links);

    if (error) {
      console.error("[ADMIN/REPASSES] Erro ao vincular pagamentos:", error);
      return res.status(500).json({ error: "Erro ao vincular pagamentos ao repasse." });
    }

    return res.json({ ok: true, repasseId, vinculados: pagamento_ids.length });
  } catch (err) {
    console.error("[ADMIN/REPASSES] Erro em /admin/repasses/:repasseId/vincular:", err);
    return res.status(500).json({ error: "Erro inesperado ao vincular pagamentos." });
  }
});

// ==========================================================
// (9) ADMIN — MARCAR REPASSE COMO PAGO (manual)
// PUT /admin/repasses/:repasseId/marcar-pago
// body: { observacao? }
// ==========================================================
app.put("/admin/repasses/:repasseId/marcar-pago", authPainel, async (req, res) => {
  try {
    if (!requireAdminSoft(req, res)) return;

    const repasseId = req.params.repasseId;
    const { observacao } = req.body || {};

    if (!repasseId) return res.status(400).json({ error: "repasseId é obrigatório." });

    const { data, error } = await supabase
      .from("repasses")
      .update({
        status: "pago",
        data_pagamento: new Date().toISOString(),
        observacao: observacao || null
      })
      .eq("id", repasseId)
      .select("id, gestor_id, competencia_mes, competencia_ano, total_bruto, total_taxa, total_liquido, status, data_pagamento, observacao, created_at")
      .single();

    if (error) {
      console.error("[ADMIN/REPASSES] Erro ao marcar repasse como pago:", error);
      return res.status(500).json({ error: "Erro ao marcar repasse como pago." });
    }

    return res.json({ ok: true, repasse: data });
  } catch (err) {
    console.error("[ADMIN/REPASSES] Erro em /admin/repasses/:repasseId/marcar-pago:", err);
    return res.status(500).json({ error: "Erro inesperado ao marcar repasse como pago." });
  }
});
// ==========================================================
// DEBUG (DEV) — SIMULAR PAGAMENTO PIX APROVADO
// POST /debug/financeiro/simular-pagamento
// body: { reservaId: "UUID" }
// - Atualiza reserva -> paid
// - Cria/atualiza pagamentos (idempotente)
// Segurança: só funciona fora de production OU com DEBUG_KEY correta
// ==========================================================
app.post("/debug/financeiro/simular-pagamento", authPainel, async (req, res) => {
  try {
    // 🔒 Trava em produção
    const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
    const debugKeyEnv = process.env.DEBUG_KEY || "";

    if (isProd) {
      const headerKey =
        req.headers["x-debug-key"] ||
        req.headers["X-Debug-Key"] ||
        req.headers["x-debug-key".toLowerCase()];

      if (!debugKeyEnv || String(headerKey || "") !== String(debugKeyEnv)) {
        return res.status(403).json({ error: "Debug desabilitado em produção." });
      }
    }

    // (Opcional) Só admin usa debug:
    // Se no seu token não existir tipo/role, não bloqueia (soft).
    const t = req.user?.tipo || req.user?.role || req.user?.perfil;
    if (t && !String(t).toUpperCase().includes("ADMIN")) {
      return res.status(403).json({ error: "Somente ADMIN pode simular pagamento." });
    }

    const { reservaId } = req.body || {};
    if (!reservaId) return res.status(400).json({ error: "reservaId é obrigatório." });

    // 1) Busca reserva
    const { data: reserva, error: rErr } = await supabase
      .from("reservas")
      .select("id, status, preco_total, quadra_id")
      .eq("id", reservaId)
      .single();

    if (rErr || !reserva) {
      console.error("[DEBUG/SIMULAR] Erro ao buscar reserva:", rErr);
      return res.status(404).json({ error: "Reserva não encontrada." });
    }

    // 2) Busca quadra -> empresa
    const { data: quadra, error: qErr } = await supabase
      .from("quadras")
      .select("id, empresa_id, gestor_id")
      .eq("id", reserva.quadra_id)
      .single();

    if (qErr || !quadra) {
      console.error("[DEBUG/SIMULAR] Erro ao buscar quadra:", qErr);
      return res.status(404).json({ error: "Quadra não encontrada para esta reserva." });
    }

    // 3) Busca empresa -> taxa
    let taxaPercent = 0;
    if (quadra.empresa_id) {
      const { data: emp, error: eErr } = await supabase
        .from("empresas")
        .select("id, taxa_plataforma")
        .eq("id", quadra.empresa_id)
        .single();

      if (!eErr && emp) {
        const n = Number(emp.taxa_plataforma);
        taxaPercent = Number.isFinite(n) ? n : 0;
      }
    }

    const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
    const total = Number(reserva.preco_total || 0);
    const taxaValor = round2(total * (taxaPercent / 100));
    const liquido = round2(total - taxaValor);

    // 4) Atualiza reserva -> paid (se ainda não estiver)
    if (String(reserva.status || "").toLowerCase() !== "paid") {
      const { error: upErr } = await supabase
        .from("reservas")
        .update({
          status: "paid",
          updated_at: new Date().toISOString()
        })
        .eq("id", reserva.id);

      if (upErr) {
        console.error("[DEBUG/SIMULAR] Erro ao atualizar reserva:", upErr);
        return res.status(500).json({ error: "Falha ao marcar reserva como paid." });
      }
    }

    // 5) Cria/atualiza pagamentos (idempotente)
    const fakeMpId = `SIM_${reserva.id}`; // mp_payment_id "fake" único por reserva

    const { data: jaExiste, error: jaErr } = await supabase
      .from("pagamentos")
      .select("id")
      .eq("mp_payment_id", fakeMpId)
      .maybeSingle();

    if (jaErr) {
      console.warn("[DEBUG/SIMULAR] Aviso ao checar pagamento existente:", jaErr);
    }

    let pagamentoFinal = null;

    if (!jaExiste) {
      const { data: ins, error: insErr } = await supabase
        .from("pagamentos")
        .insert([
          {
            reserva_id: reserva.id,
            valor_total: total,
            taxa_plataforma: taxaValor,
            valor_liquido_gestor: liquido,
            status: "paid",
            meio_pagamento: "pix",
            mp_payment_id: fakeMpId,
            mp_qr_code: null,
            mp_payload: null
          }
        ])
        .select(
          "id, reserva_id, valor_total, taxa_plataforma, valor_liquido_gestor, status, meio_pagamento, mp_payment_id, created_at"
        )
        .single();

      if (insErr) {
        console.error("[DEBUG/SIMULAR] Erro ao inserir em pagamentos:", insErr);
        return res.status(500).json({ error: "Falha ao criar pagamento simulado." });
      }

      pagamentoFinal = ins;
    } else {
      const { data: upd, error: updErr } = await supabase
        .from("pagamentos")
        .update({
          status: "paid",
          valor_total: total,
          taxa_plataforma: taxaValor,
          valor_liquido_gestor: liquido,
          updated_at: new Date().toISOString()
        })
        .eq("mp_payment_id", fakeMpId)
        .select(
          "id, reserva_id, valor_total, taxa_plataforma, valor_liquido_gestor, status, meio_pagamento, mp_payment_id, created_at, updated_at"
        )
        .single();

      if (updErr) {
        console.warn("[DEBUG/SIMULAR] Aviso ao atualizar pagamento existente:", updErr);
      }

      pagamentoFinal = upd || { ok: true };
    }

    return res.json({
      ok: true,
      reserva: { id: reserva.id, status: "paid", preco_total: total, quadra_id: reserva.quadra_id },
      taxaPercent,
      pagamento: pagamentoFinal
    });
  } catch (err) {
    console.error("[DEBUG/SIMULAR] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro inesperado ao simular pagamento." });
  }
});

// -----------------------------------------
// 4. Helpers WhatsApp
// -----------------------------------------
async function callWhatsAppAPI(payload) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[WhatsApp] Erro ao enviar mensagem:", res.status, text);
    throw new Error(`WhatsApp API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log("[WhatsApp] Resposta OK:", JSON.stringify(data));
  return data;
}
// -----------------------------------------
// Validador simples de URL HTTPS
// -----------------------------------------
function isValidHttpsUrl(url) {
  if (!url || typeof url !== "string") return false;

  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) {
    return false;
  }

  try {
    new URL(trimmed);
    return true;
  } catch (e) {
    return false;
  }
}


function buildTextMessage(waId, body) {
  return {
    messaging_product: "whatsapp",
    to: waId,
    type: "text",
    text: { body }
  };
}

async function buildWelcomeMenuMessage(waId) {
  const defaultImageUrl =
    "https://viwmjgaxztmiehyzknko.supabase.co/storage/v1/object/public/vtpbuckets/bemvindo.jpg";

  // Texto principal (corpo) – CMS + fallback
  const bodyText = await getMensagemWhatsapp({
    chave: "BOAS_VINDAS_BODY",
    contexto: "whatsapp_boas_vindas",
    defaultText:
      "🎉 Bem-vindo ao *Vai Ter Play*!\nAgende sua quadra com rapidez e segurança.\nEscolha uma opção para continuar 👇",
    gestorId: null,
    quadraId: null
  });

  // Rodapé – CMS + fallback
  const footerText = await getMensagemWhatsapp({
    chave: "BOAS_VINDAS_FOOTER",
    contexto: "whatsapp_boas_vindas",
    defaultText: "Estamos aqui para te ajudar! 💪",
    gestorId: null,
    quadraId: null
  });

  // Imagem – CMS (URL) + fallback na imagem atual
  const imageUrl = await getMensagemWhatsapp({
    chave: "BOAS_VINDAS_IMAGEM_URL",
    contexto: "whatsapp_boas_vindas",
    defaultText: defaultImageUrl,
    gestorId: null,
    quadraId: null
  });

  return {
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive: {
      type: "button",
      header: {
        type: "image",
        image: { link: imageUrl }
      },
      body: {
        text: bodyText
      },
      footer: {
        text: footerText
      },
      action: {
        buttons: [
          {
            // 🔁 AGORA É "Onde Jogar"
            type: "reply",
            reply: {
              id: "BTN_MENU_ONDE_JOGAR",
              title: "Onde Jogar"
            }
          },
          {
            type: "reply",
            reply: {
              id: "BTN_AGENDAR_QUADRA",
              title: "Agendar quadra"
            }
          },
          {
            type: "reply",
            reply: {
              id: "BTN_MEUS_AGENDAMENTOS",
              title: "Meus agendamentos"
            }
          }
        ]
      }
    }
  };
}


// =========================================
// CMS – Mensagens WhatsApp (helper genérico)
// =========================================
async function getMensagemWhatsapp({
  chave,
  contexto,
  defaultText,
  gestorId = null,
  quadraId = null
}) {
  try {
    const { data, error } = await supabase
      .from("mensagens_whatsapp")
      .select("conteudo, gestor_id, quadra_id")
      .eq("chave", chave)
      .eq("contexto", contexto);

    if (error) {
      console.error("[CMS MSG WHATS] Erro ao buscar mensagem:", error);
      return defaultText;
    }

    if (!data || data.length === 0) {
      return defaultText;
    }

    let escolhido = null;

    // 1) mais específico: gestor + quadra
    if (quadraId && gestorId) {
      escolhido = data.find(
        (m) => m.quadra_id === quadraId && m.gestor_id === gestorId
      );
    }

    // 2) só gestor (qualquer quadra)
    if (!escolhido && gestorId) {
      escolhido = data.find(
        (m) =>
          m.gestor_id === gestorId &&
          (m.quadra_id === null || m.quadra_id === undefined)
      );
    }

    // 3) global (nem gestor nem quadra)
    if (!escolhido) {
      escolhido = data.find(
        (m) =>
          (m.gestor_id === null || m.gestor_id === undefined) &&
          (m.quadra_id === null || m.quadra_id === undefined)
      );
    }

      if (escolhido && escolhido.conteudo) {
      let texto = escolhido.conteudo;

      if (typeof texto === "string") {
        // Converte "\n" literal em quebra de linha real
        texto = texto.replace(/\\n/g, "\n");
      }

      return texto;
    }

    return defaultText;

  } catch (err) {
    console.error("[CMS MSG WHATS] Erro inesperado ao buscar mensagem:", err);
    return defaultText;
  }
}


function buildFlowOpenMessage(
  waId,
  flowId,
  cta,
  flowToken,
  bodyTextOverride,
  headerTextOverride,
  footerTextOverride
) {
  console.log("[FLOW DEBUG] Abrindo flow:", {
    waId,
    flowId,
    cta,
    flowToken
  });

  // Detecta se é o Flow de AGENDAMENTO (aquele que usa /flow-data)
  const isAgendamentoFlow = String(flowId) === String(FLOW_ID_AGENDAMENTO);

  // Parâmetros básicos exigidos pelo WhatsApp Flows
  const baseParameters = {
    flow_message_version: "3",
    flow_id: flowId,
    flow_cta: cta,
    mode: "published",
    flow_token: flowToken
  };

  // 🔥 Para o Flow de agendamento, pedimos que ele use data_exchange
  // ao abrir (action = INIT) chamando o /flow-data.
  // ❗ Atenção: para CTA Flow, NÃO PODE ter flow_action_payload.
  if (isAgendamentoFlow) {
    baseParameters.flow_action = "data_exchange";
    // NADA de flow_action_payload aqui, senão dá o erro 400 que você viu
  }

  const msg = {
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive: {
      type: "flow",
      header: {
        type: "text",
        text: headerTextOverride || "VaiTerPlay ⚽ Agendamento"
      },
      body: {
        text:
          bodyTextOverride ||
          "Você escolheu o método de agendamento de quadras mais moderno e rápido do Brasil.\n\nToque em *Confirmo* para continuar."
      },
      footer: {
        text: footerTextOverride || "VaiTerPlay • agendamentos em segundos"
      },
      action: {
        name: "flow",
        parameters: baseParameters
      }
    }
  };

  console.log(
    "[FLOW DEBUG] Payload enviado para WhatsApp:",
    JSON.stringify(msg, null, 2)
  );

  return msg;
}



// -----------------------------------------
// 5. Helpers de resposta HTTP
// -----------------------------------------
function sendError(res, status = 500, message = "Erro interno", extra = {}) {
  console.error("[ERRO]", message, extra);
  return res.status(status).json({ ok: false, error: message, ...extra });
}

// -----------------------------------------
// 6. WEBHOOK GET (verificação do Meta)
// -----------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("[WEBHOOK GET] Verificação OK");
    return res.status(200).send(challenge);
  }

  console.log("[WEBHOOK GET] Verificação falhou");
  return res.sendStatus(403);
});

// -----------------------------------------
// 7. Validação da assinatura (segurança)
// -----------------------------------------
function isValidSignature(req) {
  try {
    const signatureHeader = req.headers["x-hub-signature-256"];
    if (!signatureHeader) {
      console.log("[ASSINATURA] Header x-hub-signature-256 ausente");
      return false;
    }
    const [prefix, receivedHash] = String(signatureHeader).split("=");
    if (prefix !== "sha256" || !receivedHash) {
      console.log("[ASSINATURA] Formato da assinatura inválido");
      return false;
    }

    const body = req.rawBody || "";
    const expectedHash = crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");

    console.log("[WEBHOOK POST] assinatura recebida = sha256=" + receivedHash);
    console.log("[WEBHOOK POST] assinatura esperada = sha256=" + expectedHash);

    const received = Buffer.from(receivedHash, "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (received.length !== expected.length) {
      console.log("[ASSINATURA] Tamanho diferente");
      return false;
    }
    if (!crypto.timingSafeEqual(received, expected)) {
      console.log("[ASSINATURA] Assinatura inválida");
      return false;
    }

    return true;
  } catch (err) {
    console.error("[ASSINATURA] Erro ao validar:", err);
    return false;
  }
}

// -----------------------------------------
// 8. Helpers de negócio (Supabase)
// -----------------------------------------
function normalizarCpf(cpf) {
  if (!cpf) return null;
  const digits = String(cpf).replace(/\D/g, "");
  if (digits.length !== 11) return null;
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

// ---------------------------------------------------------
// 1) Garantir que o usuário existe na tabela "usuarios"
//    - Se ainda não existir -> insere
//    - Se já existir (erro 23505) -> busca e reaproveita
// ---------------------------------------------------------
async function upsertUsuario({ nome_completo, cpf, waId }) {
  let usuarioId;

  try {
    const { data: novoUsuario, error: usuarioInsertError } = await supabase
      .from("usuarios")
      .insert({
        celular: waId,               // ex: '5522988088929'
        nome_completo,               // vem do Flow
        cpf: normalizarCpf(cpf)      // salva formatado
        // email: null,
        // taxa_plataforma_percent: 10.0 // já tem default na tabela
      })
      .select()
      .single();

    if (usuarioInsertError) {
      // 🔁 Caso clássico: o celular já está cadastrado
      if (usuarioInsertError.code === "23505") {
        console.log("[SUPA] Usuário já existe, buscando pelo celular...");

        const { data: usuarioExistente, error: usuarioBuscaError } = await supabase
          .from("usuarios")
          .select("*")
          .eq("celular", waId)
          .single();

        if (usuarioBuscaError) {
          console.error("[SUPA] Erro ao buscar usuário existente:", usuarioBuscaError);
          throw usuarioBuscaError;
        }

        usuarioId = usuarioExistente.id;
      } else {
        // 🧨 Qualquer outro erro de banco, aí sim paramos tudo
        console.error("[SUPA] Erro ao inserir usuário:", usuarioInsertError);
        throw usuarioInsertError;
      }
    } else {
      // ✅ Inseriu usuário agora
      usuarioId = novoUsuario.id;
    }
  } catch (err) {
    console.error("[FLOW Agendamento] Erro ao garantir usuário:", err);
    throw err; // vai ser tratado no catch geral do fluxo
  }

  return usuarioId;
}

async function buscarQuadra(id_quadra) {
  const { data, error } = await supabase
    .from("quadras")
    .select("*")
    .eq("id", id_quadra)
    .single();

  if (error) {
    console.error("[SUPA] Erro ao buscar quadra:", error);
    throw error;
  }
  return data;
}

async function buscarRegraHorario(id_regra) {
  const { data, error } = await supabase
    .from("regras_horarios")
    .select("*")
    .eq("id", id_regra)
    .single();

  if (error) {
    console.error("[SUPA] Erro ao buscar regra de horário:", error);
    throw error;
  }
  return data;
}

/**
 * Criar agendamento:
 * - Verifica se já existe reserva (mesma quadra + data + hora) com status pending/paid
 *   → se existir, lança erro HORARIO_INDISPONIVEL (UX rápida)
 * - Tenta inserir a reserva com status "pending"
 *   → se bater no índice único parcial (erro 23505), também trata como HORARIO_INDISPONIVEL
 */
async function criarAgendamento({
  id_usuario,
  id_quadra,
  data_agendamento,
  regra,
  waId,
  cpf
}) {
  // 0) Normaliza CPF com fallback para o valor bruto (evita NOT NULL)
  const cpfNormalizado = normalizarCpf(cpf) || cpf;

  // 1) Verificar, via SELECT, se já existe reserva para mesma quadra + data + hora (pending ou paid)
  const { data: reservasExistentes, error: erroCheck } = await supabase
    .from("reservas")
    .select("id, status")
    .eq("quadra_id", id_quadra)
    .eq("data", data_agendamento)
    .eq("hora", regra.hora_inicio)
    .in("status", ["pending", "paid", "pendente", "pago"]);


  if (erroCheck) {
    console.error("[SUPA] Erro ao checar conflito de horário:", erroCheck);
    throw erroCheck;
  }

  if (reservasExistentes && reservasExistentes.length > 0) {
    const err = new Error("HORARIO_INDISPONIVEL");
    err.code = "HORARIO_INDISPONIVEL";
    throw err;
  }

  // 2) Tentar criar a reserva (sem deletar nada, confiando no índice parcial)
  try {
    const { data, error } = await supabase
      .from("reservas")
      .insert([
        {
          usuario_id: id_usuario,
          quadra_id: id_quadra,
          data: data_agendamento,
          hora: regra.hora_inicio,
          user_cpf: cpfNormalizado,
          preco_total: regra.valor,
          status: "pending",
          phone: waId,
          origem: "whatsapp",
          created_at: new Date().toISOString()
          // id_transacao_pix: será preenchido depois, quando o PIX for criado
        }
      ])
      .select()
      .single();

    // Se o Supabase retornou erro, tratamos aqui
    if (error) {
      // 23505 = violação de UNIQUE (índice parcial de horário ativo)
      if (error.code === "23505") {
        console.warn(
          "[SUPA] Conflito de horário ao inserir (erro 23505). Tratando como HORARIO_INDISPONIVEL."
        );
        const err = new Error("HORARIO_INDISPONIVEL");
        err.code = "HORARIO_INDISPONIVEL";
        throw err;
      }

      console.error("[SUPA] Erro ao criar agendamento:", error);
      throw error;
    }

    return data;
  } catch (err) {
    // Segurança extra: se por algum motivo o erro vier via exceção e não via `error`
    if (err && err.code === "23505") {
      console.warn(
        "[SUPA] Conflito de horário (catch) ao inserir. Tratando como HORARIO_INDISPONIVEL."
      );
      const conflito = new Error("HORARIO_INDISPONIVEL");
      conflito.code = "HORARIO_INDISPONIVEL";
      throw conflito;
    }

    console.error("[SUPA] Erro inesperado em criarAgendamento:", err);
    throw err;
  }
}


async function enviarResumoAgendamentoPendente(waId, agendamento, quadra) {
  const quadraNome = buildNomeQuadraDinamico(quadra);

  const mensagem = `📋 *Reserva registrada (aguardando pagamento)*

Quadra: ${quadraNome}
Data: ${agendamento.data}
Hora: ${agendamento.hora}
Valor: R$ ${agendamento.preco_total.toFixed(2)}

O código PIX foi enviado em outra mensagem.
Assim que o pagamento for confirmado pelo banco/ Mercado Pago,
você receberá uma mensagem automática de confirmação aqui no WhatsApp.`;
  await callWhatsAppAPI(buildTextMessage(waId, mensagem));
}

async function enviarResumoAgendamentos(waId, cpfBruto) {
  try {
    // 1. Tratamento do CPF (Deixa apenas números)
    const cpf = String(cpfBruto || "").replace(/\D/g, "");

    if (cpf.length !== 11) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "CPF inválido. Digite os *11 números* (sem pontos e traço)."
        )
      );
      return;
    }

    // 2. Definição das Datas (Hoje, -60 dias e +60 dias)
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const inicio = new Date(hoje);
    inicio.setDate(inicio.getDate() - 60);

    const fim = new Date(hoje);
    fim.setDate(fim.getDate() + 60);

    const formatISODate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const inicioStr = formatISODate(inicio);
    const fimStr = formatISODate(fim);

    // 3. Consulta ao Supabase
    const { data, error } = await supabase
      .from("reservas")
      .select("id, data, hora, status, quadras ( id, tipo, material, modalidade )")
      .eq("user_cpf", cpf)
      .gte("data", inicioStr)
      .lte("data", fimStr)
      .order("data", { ascending: true });

    if (error) throw error;

    // 4. Verificação se encontrou algo
    if (!data || data.length === 0) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Não encontramos agendamentos para este CPF nos últimos ou próximos 60 dias."
        )
      );
      return;
    }

    // 5. Montagem da Mensagem de Resposta
    let mensagem = "📆 *Seus agendamentos (período de 120 dias)*\n\n";

    data.forEach((r) => {
      const quadraNome = r.quadras
        ? buildNomeQuadraDinamico(r.quadras)
        : "Quadra não identificada";

      const dataFormatadaBR = String(r.data || "")
        .split("-")
        .reverse()
        .join("/");

      // ✅ NOVO: descrição baseada na data/hora (passado vs futuro/hoje)
      const descricao = getDescricaoReservaPorData(r.data, r.hora);

      mensagem +=
        `• ID: ${r.id}\n` +
        `  Quadra: ${quadraNome}\n` +
        `  Data: ${dataFormatadaBR} às ${r.hora}\n` +
        `  Status: ${r.status === "paid" ? "✅ Pago" : "⏳ Pendente"}\n` +
        `  ${descricao}\n\n`;
    });

    //mensagem += 'Precisa cancelar? Responda "cancelar [ID reserva]".';

    await callWhatsAppAPI(buildTextMessage(waId, mensagem));
  } catch (err) {
    console.error("[FUNÇÃO] Erro em enviarResumoAgendamentos:", err);
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Ocorreu um erro ao buscar seus agendamentos. Tente novamente mais tarde."
      )
    );
  }
}

function parseDataHoraReservaToDate(dataISO, horaStr) {
  if (!dataISO) return null;

  const [y, m, d] = String(dataISO).split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;

  let hh = 0,
    mm = 0,
    ss = 0;

  if (horaStr) {
    const parts = String(horaStr).split(":");
    hh = parseInt(parts[0] || "0", 10) || 0;
    mm = parseInt(parts[1] || "0", 10) || 0;
    ss = parseInt(parts[2] || "0", 10) || 0;
  }

  return new Date(y, m - 1, d, hh, mm, ss, 0);
}

function getDescricaoReservaPorData(dataISO, horaStr) {
  const dtReserva = parseDataHoraReservaToDate(dataISO, horaStr);

  // fallback seguro
  if (!dtReserva) {
    return "Imprevistos acontecem? Para cancelar ou reagendar, fale diretamente com o estabelecimento.";
  }

  const agora = new Date();
  const isPassado = dtReserva.getTime() < agora.getTime();

  return isPassado
    ? "Agendamento finalizado. Para novas reservas, inicie uma nova conversa."
    : "Imprevistos acontecem? Para cancelar ou reagendar, fale diretamente com o estabelecimento.";
}



// -----------------------------------------
// Helper: monta o "nome" dinâmico da quadra
// (TIPO + MATERIAL + MODALIDADE)
// -----------------------------------------
function buildNomeQuadraDinamico(quadraLike) {
  if (!quadraLike || typeof quadraLike !== "object") {
    return "QUADRA SEM DEFINIÇÃO";
  }

  const partes = [
    quadraLike.tipo || "",
    quadraLike.material || "",
    quadraLike.modalidade || ""
  ]
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => s.length > 0);

  if (partes.length === 0) {
    return "QUADRA SEM DEFINIÇÃO";
  }

  return partes.join(" ");
}



// -----------------------------------------
// SESSÃO SIMPLES POR CONTATO
// (menu "Onde Jogar" -> Empresas -> Quadras)
// -----------------------------------------
const sessions = {}; // chave = waId (número do WhatsApp)

function getSession(waId) {
  if (!waId) {
    return {
      state: "IDLE",               // IDLE | LISTANDO_COMPLEXOS | LISTANDO_QUADRAS_DO_COMPLEXO | MOSTRANDO_QUADRA
      empresasList: [],            // lista de complexos
      quadrasList: [],             // lista de quadras do complexo escolhido
      empresaSelecionada: null     // complexo atualmente selecionado
    };
  }
  if (!sessions[waId]) {
    sessions[waId] = {
      state: "IDLE",
      empresasList: [],
      quadrasList: [],
      empresaSelecionada: null
    };
  }
  return sessions[waId];
}

function resetSessionNavigation(session) {
  if (!session) return;
  session.state = "IDLE";
  session.empresasList = [];
  session.quadrasList = [];
  session.empresaSelecionada = null;
}

// -----------------------------------------
// 1º nível: lista de EMPRESAS (complexos)
// → Agora só mostra empresas ATIVAS (ativo = true)
// -----------------------------------------
async function sendEmpresasListFromSupabase(waId) {
  const session = getSession(waId);

  const { data, error } = await supabase
    .from("empresas")
    .select(
      `
      id,
      nome,
      endereco_resumo,
      link_site_ou_rede,
      link_google_maps,
      ativo
    `
    )
    .eq("ativo", true) // 🔴 só complexos ativos vão aparecer no WhatsApp
    .order("nome", { ascending: true });

  if (error) {
    console.error("[SUPABASE] Erro ao buscar empresas:", error);
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Não consegui carregar a lista de complexos agora. Tente novamente em alguns instantes."
      )
    );
    return;
  }

  if (!data || data.length === 0) {
    await callWhatsAppAPI(
      buildTextMessage(waId, "Ainda não temos complexos cadastrados.")
    );
    return;
  }

  session.state = "LISTANDO_COMPLEXOS";
  session.empresasList = data;
  session.quadrasList = [];
  session.empresaSelecionada = null;

  let texto = "🏟️ *Onde jogar hoje?*\n\n";
  data.forEach((e, idx) => {
    const idxHumano = idx + 1;
    const enderecoLinha = e.endereco_resumo || "";
    texto += `${idxHumano} - ${e.nome}${
      enderecoLinha ? " (" + enderecoLinha + ")" : ""
    }\n`;
  });
  texto += "\nDigite o número do complexo ou 'menu' para voltar.";

  await callWhatsAppAPI(buildTextMessage(waId, texto));
}


// -----------------------------------------
// 2º nível: lista de QUADRAS de um complexo
// -----------------------------------------
async function sendQuadrasDoComplexo(waId, empresa) {
  const session = getSession(waId);

  if (!empresa || !empresa.id) {
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Não consegui identificar o complexo escolhido. Vou mostrar a lista novamente."
      )
    );
    return sendEmpresasListFromSupabase(waId);
  }

  const { data, error } = await supabase
    .from("quadras")
    .select(
      `
      id,
      tipo,
      material,
      modalidade,
      informacoes,
      url_imagem_header,
      url_imagem_2,
      url_imagem_3,
      gestor_id,
      empresa_id
    `
    )
    .eq("empresa_id", empresa.id)
    .order("tipo", { ascending: true })
    .order("material", { ascending: true })
    .order("modalidade", { ascending: true });

  if (error) {
    console.error("[SUPABASE] Erro ao buscar quadras do complexo:", error);
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Não consegui carregar as quadras desse complexo agora. Tente novamente em instantes."
      )
    );
    return;
  }

  if (!data || data.length === 0) {
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Ainda não temos quadras cadastradas para esse complexo."
      )
    );
    return;
  }

  session.state = "LISTANDO_QUADRAS_DO_COMPLEXO";
  session.empresaSelecionada = empresa;
  session.quadrasList = data;

  // Links AGORA são da EMPRESA (não mais das quadras)
  const linkSite = isValidHttpsUrl(empresa.link_site_ou_rede)
    ? empresa.link_site_ou_rede.trim()
    : "";
  const linkMaps = isValidHttpsUrl(empresa.link_google_maps)
    ? empresa.link_google_maps.trim()
    : "";

  let texto = `🏟️ *${empresa.nome}*\n`;
  if (empresa.endereco_resumo) {
    texto += `📍 ${empresa.endereco_resumo}\n`;
  }
  if (linkSite) {
    texto += `🌐 Site/Redes: ${linkSite}\n`;
  }
  if (linkMaps) {
    texto += `🗺️ Maps: ${linkMaps}\n`;
  }

  texto += "\n*Escolha uma quadra:*\n\n";

  data.forEach((q, idx) => {
    const idxHumano = idx + 1;
    const tituloQuadra = buildNomeQuadraDinamico(q);
    texto += `${idxHumano} - ${tituloQuadra}\n`;
  });

  texto += "\nDigite o número da quadra ou '0' para voltar aos complexos.";

  await callWhatsAppAPI(buildTextMessage(waId, texto));
}


// -----------------------------------------
// 3º nível: detalhes da quadra + fotos + botões
// -----------------------------------------
async function sendQuadraDetailsWithPhoto(waId, quadra) {
  const session = getSession(waId);
  session.state = "MOSTRANDO_QUADRA";

  // 1. Dados do COMPLEXO (vem da sessão)
  const empresa = session.empresaSelecionada || {};

  const nomeComplexo =
    (empresa && empresa.nome) ||
    quadra.nome_complexo ||
    "Complexo esportivo";

  // Endereço AGORA vem só da EMPRESA
  const enderecoComplexo =
    (empresa && empresa.endereco_resumo) ||
    "Endereço não informado. Consulte o gestor do complexo.";

  // 2. Nome da quadra: TIPO + MATERIAL + MODALIDADE (SEM fallback para quadra.nome de banco)
  const nomeQuadraLinha = buildNomeQuadraDinamico(quadra);

  // 3. Informações e aviso da quadra (continuam na TABELA QUADRAS)
  const informacoes = quadra.informacoes || "";
  const avisoExtra = quadra.aviso || "";

  // Links AGORA vêm da EMPRESA
  const rawLinkMaps = empresa.link_google_maps || "";
  const rawLinkSite = empresa.link_site_ou_rede || "";

  const linkMaps = isValidHttpsUrl(rawLinkMaps)
    ? rawLinkMaps.trim()
    : "";
  const linkSite = isValidHttpsUrl(rawLinkSite)
    ? rawLinkSite.trim()
    : "";

  // 4. Fotos: Header + Foto 2 + Foto 3
  const rawFotoPrincipal = quadra.url_imagem_header || quadra.foto || "";
  const rawFoto2 = quadra.url_imagem_2 || "";
  const rawFoto3 = quadra.url_imagem_3 || ""; // <--- Garanta que essa linha existe

  const fotoPrincipal = isValidHttpsUrl(rawFotoPrincipal)
    ? rawFotoPrincipal.trim()
    : "";

  // Adicione a rawFoto3 dentro dos colchetes [ ]
  const fotosExtras = [rawFoto2, rawFoto3] 
    .map((u) => (isValidHttpsUrl(u) ? u.trim() : ""))
    .filter((u) => u.length > 0);

  // 5. Texto principal (caption)
  const captionLines = [];

  // Linha 1: Nome do Complexo
  captionLines.push(`🏟️ *${nomeComplexo}*`);

  // Linha 2: Nome da quadra (tipo + material + modalidade)
  captionLines.push(`🥅 ${nomeQuadraLinha}`);

  // Linha 3: Endereço
  if (enderecoComplexo) captionLines.push(`📍 ${enderecoComplexo}`);

  // Informações da quadra
  if (informacoes) captionLines.push(`ℹ️ ${informacoes}`);

  // Aviso da QUADRA (ex: chuteira, descalço etc.)
  if (avisoExtra) captionLines.push(`⚠️ ${avisoExtra}`);

  // Links da EMPRESA
  if (linkSite) captionLines.push(`🌐 Site/Redes: ${linkSite}`);
  if (linkMaps) captionLines.push(`🗺️ Maps: ${linkMaps}`);

  captionLines.push("");
  captionLines.push(
    "Se decidir escolher essa quadra, *guarde esse nome*."
  );
  captionLines.push(
    "Ele será oferecido na próxima etapa de agendamento 😉"
  );

  if (!fotoPrincipal && fotosExtras.length === 0) {
    captionLines.push("");
    captionLines.push("📷 Fotos em breve ou não cadastradas.");
  } else if (!fotoPrincipal && fotosExtras.length > 0) {
    captionLines.push("");
    captionLines.push("📷 Confira algumas fotos dessa quadra abaixo.");
  }

  const caption = captionLines.join("\n");

  // 6. PRIMEIRO: card principal (foto ou texto)
  if (fotoPrincipal) {
    await callWhatsAppAPI({
      messaging_product: "whatsapp",
      to: waId,
      type: "image",
      image: {
        link: fotoPrincipal,
        caption
      }
    });
  } else {
    await callWhatsAppAPI(buildTextMessage(waId, caption));
  }

  // 7. SEGUNDO: fotos extras (apenas url_imagem_2 agora), sem legenda grande
  for (const foto of fotosExtras) {
    await callWhatsAppAPI({
      messaging_product: "whatsapp",
      to: waId,
      type: "image",
      image: {
        link: foto
      }
    });
  }

  // 8. TERCEIRO: card "O que você quer fazer agora?"
  await new Promise((resolve) => setTimeout(resolve, 1500)); // 1,5s

  const textoOQueFazer = await getMensagemWhatsapp({
    chave: "O_QUE_FAZER_AGORA",
    contexto: "whatsapp_card_opcoes",
    defaultText: "O que você quer fazer agora?",
    gestorId: quadra.gestor_id || null,
    quadraId: quadra.id || quadra.quadra_id || null
  });

  const botoesMsg = {
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: textoOQueFazer
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "BTN_AGENDAR_QUADRA",
              title: "Agendar esta quadra"
            }
          },
          {
            type: "reply",
            reply: {
              id: "BTN_VER_OUTRA_QUADRA",
              title: "Ver outra quadra"
            }
          },
          {
            type: "reply",
            reply: {
              id: "BTN_MENU_PRINCIPAL",
              title: "Menu Principal"
            }
          }
        ]
      }
    }
  };

  await callWhatsAppAPI(botoesMsg);
}




// Helper para interpretar datas vindas do Flow
// Aceita: AAAA-MM-DD, DD/MM/AAAA
function parseDataAgendamentoBr(str) {
  if (!str) return null;
  const s = String(str).trim();

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    return isNaN(dt.getTime()) ? null : dt;
  }

  const brMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, dia, mes, ano] = brMatch;
    const dt = new Date(Number(ano), Number(mes) - 1, Number(dia));
    return isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

function formatDateISO(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
  return dateObj.toISOString().slice(0, 10);
}
// ===== BLOCO H - FLOW CRYPTO (decryptFlowRequest, encryptFlowResponse, buildFlowResponsePayload) =====
// -----------------------------------------
// 9. Helpers de criptografia para /flow-data
//     (implementação alinhada ao exemplo oficial da Meta)
// -----------------------------------------


/**
 * Função oficial de decrypt da Meta, adaptada:
 * - Lê encrypted_aes_key / encrypted_flow_data / initial_vector
 * - Descriptografa AES key com RSA-OAEP SHA-256
 * - Descriptografa payload com AES-128-GCM
 */
function decryptFlowRequest(body) {
  console.log(
    "[CRYPTO] decryptFlowRequest() raw body:",
    JSON.stringify(body, null, 2)
  );

  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body || {};

  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    const err = new Error(
      "Corpo criptografado inválido: campos encrypted_aes_key/encrypted_flow_data/initial_vector ausentes."
    );
    err.name = "DecryptInvalidBody";
    throw err;
  }

  // 1) Decrypt da AES key criada pelo cliente (igual ao exemplo da doc)
  let decryptedAesKey;
  try {
    decryptedAesKey = crypto.privateDecrypt(
      {
        key: crypto.createPrivateKey(PRIVATE_KEY),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encrypted_aes_key, "base64")
    );
  } catch (err) {
    console.error("[CRYPTO] Erro ao descriptografar AES key (RSA-OAEP-256):", err);
    // Esse erro é exatamente o 'oaep decoding error' que você viu
    err.name = "DecryptAESKeyError";
    throw err;
  }

  // 2) Decrypt do flow_data (AES-128-GCM) – exatamente como na doc
  const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
  const initialVectorBuffer = Buffer.from(initial_vector, "base64");

  const TAG_LENGTH = 16;
  if (flowDataBuffer.length <= TAG_LENGTH) {
    const err = new Error("encrypted_flow_data muito curto para conter tag GCM.");
    err.name = "DecryptFlowDataError";
    throw err;
  }

  const encrypted_flow_data_body = flowDataBuffer.subarray(0, -TAG_LENGTH);
  const encrypted_flow_data_tag = flowDataBuffer.subarray(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv(
    "aes-128-gcm",
    decryptedAesKey,
    initialVectorBuffer
  );
  decipher.setAuthTag(encrypted_flow_data_tag);

  let decryptedJSONString;
  try {
    decryptedJSONString = Buffer.concat([
      decipher.update(encrypted_flow_data_body),
      decipher.final()
    ]).toString("utf-8");
  } catch (err) {
    console.error("[CRYPTO] Erro ao descriptografar payload AES-GCM:", err);
    err.name = "DecryptFlowDataError";
    throw err;
  }

  let decryptedBody;
  try {
    decryptedBody = JSON.parse(decryptedJSONString);
  } catch (err) {
    console.error(
      "[CRYPTO] Payload descriptografado não é JSON válido:",
      decryptedJSONString
    );
    err.name = "DecryptJSONError";
    throw err;
  }

  console.log("[CRYPTO] Payload decriptado com sucesso.");

  return {
    decryptedBody,
    aesKeyBuffer: decryptedAesKey,
    initialVectorBuffer
  };
}

/**
 * Implementação oficial de encrypt da Meta:
 * - Usa a MESMA AES key recebida
 * - Usa IV invertido bit a bit
 * - AES-128-GCM
 * - Resposta: Base64 (string) em texto plano
 */
function encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer) {
  // Flip no IV (igual à doc)
  const flipped_iv = [];
  for (const pair of initialVectorBuffer.entries()) {
    flipped_iv.push(~pair[1]);
  }

  const cipher = crypto.createCipheriv(
    "aes-128-gcm",
    aesKeyBuffer,
    Buffer.from(flipped_iv)
  );

  const encryptedBuffer = Buffer.concat([
    cipher.update(JSON.stringify(responseObject), "utf-8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);

  const base64Response = encryptedBuffer.toString("base64");
  console.log("[CRYPTO] Resposta encryptada (Base64).");
  return base64Response;
}

function buildFlowResponsePayload(payloadReq, screen, dataForScreen) {
  return {
    screen: screen || payloadReq.screen || null,
    data: dataForScreen || {}
  };
}
// ==========================================================
// ARMAZENAMENTO TEMPORÁRIO DE QR CODES PIX EM MEMÓRIA
// ==========================================================

// Mapa em memória: cada qrId aponta para um Buffer da imagem
const qrCodeStore = new Map();

// Endpoint para servir o QR Code como imagem via URL temporária
// Ex.: http://localhost:3000/qr-temp/ALGUM_ID
app.get("/qr-temp/:id", (req, res) => {
  const { id } = req.params;
  const buffer = qrCodeStore.get(id);

  if (!buffer) {
    return res.status(404).send("QR Code expirado ou não encontrado.");
  }

  res.setHeader("Content-Type", "image/png");
  res.send(buffer);
});

// ==========================================================
// PROXY DE IMAGENS (CDN local pro WhatsApp Flow)
// ==========================================================
app.get("/img", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !url.startsWith("https")) {
      return res.status(400).send("URL inválida");
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send("Imagem não encontrada");
    }

    // Passa o header original ou força para jpeg
    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    console.error("Erro no proxy de imagem:", e.message);
    res.status(400).send("Erro ao carregar imagem");
  }
});
// ==========================================================
// WEBHOOK DO MERCADO PAGO (confirmação automática de pagamento)
// ==========================================================
app.post("/mp-webhook", async (req, res) => {
  try {
    console.log("[MP WEBHOOK] body recebido:", JSON.stringify(req.body, null, 2));
    console.log("[MP WEBHOOK] query recebida:", JSON.stringify(req.query || {}, null, 2));

    const body = req.body || {};
    const type = (body.type || req.query.type || req.query.topic || "")
      .toString()
      .toLowerCase();
    const action = (body.action || "").toString().toLowerCase();

    const paymentId =
      body?.data?.id ||
      body?.data?.["id"] ||
      body?.id ||
      req.query?.data_id ||
      req.query?.["data.id"] ||
      req.query?.id ||
      null;

    const isPaymentEvent =
      type === "payment" ||
      type === "payments" ||
      action.includes("payment") ||
      req.query?.topic === "payment" ||
      req.query?.type === "payment";

    if (!isPaymentEvent || !paymentId) {
      console.log("[MP WEBHOOK] Evento ignorado (não é payment ou sem paymentId).", {
        type,
        action,
        paymentId,
      });
      return res.sendStatus(200);
    }

    // 1) Busca pagamento completo no MP
    const payment = await mpPayment.get({ id: paymentId });
    const p = payment?.response || payment;

    console.log("[MP WEBHOOK] Pagamento recuperado:", {
      id: p?.id,
      status: p?.status,
      status_detail: p?.status_detail,
    });

    if (String(p?.status || "").toLowerCase() !== "approved") {
      console.log("[MP WEBHOOK] Pagamento ainda não aprovado. Status:", p?.status);
      return res.sendStatus(200);
    }

    // 2) Atualiza reserva para paid + pago_via_pix (idempotente)
    const { data: reservaAtualizada, error: updErr } = await supabase
      .from("reservas")
      .update({
        status: "paid",
        pago_via_pix: true, // ✅ importante pro seu financeiro bater certinho
        updated_at: new Date().toISOString(),
      })
      .eq("id_transacao_pix", String(p.id))
      .neq("status", "paid")
      .select(
        `
        id,
        phone,
        data,
        hora,
        preco_total,
        quadras (
          id,
          tipo,
          material,
          modalidade,
          gestor_id,
          empresa_id,
          taxa_plataforma_override
        )
        `
      )
      .maybeSingle();

    if (updErr) {
      console.error("[MP WEBHOOK] Erro ao atualizar reserva no Supabase:", updErr);
      return res.sendStatus(200);
    }

    if (!reservaAtualizada) {
      console.log(
        "[MP WEBHOOK] Reserva não atualizada (não encontrada OU já estava paid) para id_transacao_pix =",
        String(p.id)
      );
      return res.sendStatus(200);
    }

    // 2.1) Registra/atualiza em pagamentos (idempotente por mp_payment_id)
    try {
      const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

      const total = Number(reservaAtualizada.preco_total || 0);

      // taxa plataforma (%): override quadra > taxa global gestor > taxa empresa
      let taxaPercent = 0;

      const quadra = reservaAtualizada.quadras || null;
      const quadraOverride = quadra?.taxa_plataforma_override;

      if (quadraOverride !== null && quadraOverride !== undefined) {
        const n = Number(quadraOverride);
        taxaPercent = Number.isFinite(n) ? n : 0;
      } else {
        const gestorId = quadra?.gestor_id || null;

        if (gestorId) {
          const { data: g, error: gErr } = await supabase
            .from("gestores")
            .select("taxa_plataforma_global")
            .eq("id", gestorId)
            .maybeSingle();

          if (!gErr && g && g.taxa_plataforma_global !== null && g.taxa_plataforma_global !== undefined) {
            const n = Number(g.taxa_plataforma_global);
            taxaPercent = Number.isFinite(n) ? n : 0;
          }
        }

        if (!taxaPercent) {
          const empresaId = quadra?.empresa_id || null;

          if (empresaId) {
            const { data: emp, error: empErr } = await supabase
              .from("empresas")
              .select("taxa_plataforma")
              .eq("id", empresaId)
              .maybeSingle();

            if (!empErr && emp && emp.taxa_plataforma !== null && emp.taxa_plataforma !== undefined) {
              const n = Number(emp.taxa_plataforma);
              taxaPercent = Number.isFinite(n) ? n : 0;
            }
          }
        }
      }

      const taxaValor = round2(total * (taxaPercent / 100));
      const liquido = round2(total - taxaValor);

      const mpQr = p?.point_of_interaction?.transaction_data?.qr_code || null;
      const mpPayload = p?.point_of_interaction?.transaction_data?.qr_code_base64 || null;

      const payloadPagamento = {
        reserva_id: reservaAtualizada.id,
        valor_total: total,
        taxa_plataforma: taxaValor,
        valor_liquido_gestor: liquido,
        status: "paid",
        meio_pagamento: "pix",
        mp_payment_id: String(p.id), // ✅ chave de idempotência
        mp_qr_code: mpQr,
        mp_payload: mpPayload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: pagUpsert, error: upsertErr } = await supabase
        .from("pagamentos")
        .upsert([payloadPagamento], { onConflict: "mp_payment_id" })
        .select("id, mp_payment_id, reserva_id")
        .maybeSingle();

      if (upsertErr) {
        console.error("[MP WEBHOOK] Erro ao upsert em pagamentos:", upsertErr);
      } else {
        console.log("[MP WEBHOOK] Pagamento registrado/atualizado em pagamentos:", pagUpsert);
      }
    } catch (e) {
      console.error("[MP WEBHOOK] Falha inesperada ao registrar pagamentos:", e);
    }

    // 3) WhatsApp confirmação
    const telefone = reservaAtualizada.phone;
    const nomeQuadra = buildNomeQuadraDinamico(reservaAtualizada.quadras || null);
    const dataReserva = reservaAtualizada.data;
    const horaReserva = reservaAtualizada.hora;

    if (telefone) {
      const msgConfirmacao =
        `✅ *Pagamento confirmado!*\n\n` +
        `Sua reserva foi aprovada com sucesso.\n\n` +
        `Quadra: ${nomeQuadra}\n` +
        `Data: ${dataReserva}\n` +
        `Hora: ${horaReserva}\n\n` +
        `Obrigado por usar o VaiTerPlay!`;

      await callWhatsAppAPI(buildTextMessage(telefone, msgConfirmacao));
    } else {
      console.warn("[MP WEBHOOK] Reserva atualizada, mas sem telefone cadastrado:", reservaAtualizada);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("[MP WEBHOOK] Erro ao processar webhook do Mercado Pago:", err);
    return res.sendStatus(200);
  }
});




// ===== BLOCO J - FLOW DATA ENTRYPOINT (/flow-data: decrypt, ping, roteamento básico) =====
// -----------------------------------------
// 10. ROTA DE DATA_EXCHANGE (FLOW 7.2 / v3.0)
// -----------------------------------------
app.post("/flow-data", async (req, res) => {
  console.log(
    "[FLOW DATA] body recebido (bruto):",
    JSON.stringify(req.body, null, 2)
  );

  const body = req.body || {};

  // =====================================================
  // PASSO 0 - Health check simples (sem criptografia)
  // =====================================================
  if (!body || Object.keys(body).length === 0) {
    console.log("[FLOW DATA] Corpo vazio - health check.");
    return res.status(200).json({ data: { status: "active" } });
  }

  // Health check PLAIN: { version: "3.0", action: "ping" }
  if (
    body.action === "ping" &&
    body.version === "3.0" &&
    !body.encrypted_aes_key &&
    !body.encrypted_flow_data
  ) {
    console.log("[FLOW DATA] Health check ping (sem cripto).");
    return res.status(200).json({ data: { status: "active" } });
  }

  // Notificação de erro do Flow (sem cripto)
  if (
    body.data &&
    body.data.error &&
    !body.encrypted_aes_key &&
    !body.encrypted_flow_data
  ) {
    console.log("[FLOW DATA] Error notification recebido:", body.data);
    return res.status(200).json({ data: { acknowledged: true } });
  }

  // =====================================================
  // PASSO 1 - Decrypt (sempre que vier criptografado)
  // =====================================================
  let decryptedBody;
  let aesKeyBuffer;
  let initialVectorBuffer;
  let currentScreen = null;

  try {
    const decryptResult = decryptFlowRequest(body);
    decryptedBody = decryptResult.decryptedBody;
    aesKeyBuffer = decryptResult.aesKeyBuffer;
    initialVectorBuffer = decryptResult.initialVectorBuffer;
  } catch (err) {
    console.error("[FLOW DATA] ERRO ao descriptografar payload:", err);
    // Não conseguimos usar AES para responder, então devolvemos JSON simples
    return res
      .status(400)
      .json({ ok: false, error: "Erro ao descriptografar payload do Flow." });
  }

  console.log("[FLOW DATA] payload decriptado =", decryptedBody);

  const action = decryptedBody.action;
  const screenRaw = decryptedBody.screen;
  const dataIn = decryptedBody.data || {};
  const payloadIn = decryptedBody.payload || {};
  const screenState = decryptedBody.screen_state || {};
  const version = decryptedBody.version || "3.0";

  // Normaliza o screen:
  // pode vir string ou objeto { id: "EMPRESA_SELECT_SCREEN" }
  if (screenRaw && typeof screenRaw === "object") {
    currentScreen = screenRaw.id || screenRaw.name || null;
  } else {
    currentScreen = screenRaw || null;
  }

  // Quando abre pela primeira vez (INIT), pode vir sem "screen"
  if ((!currentScreen || currentScreen === null) && action === "INIT") {
    currentScreen = "EMPRESA_SELECT_SCREEN";
  }

  console.log(
    "[FLOW DATA] Roteamento → action =",
    action,
    "| screenRaw =",
    screenRaw,
    "| currentScreen(normalizado) =",
    currentScreen
  );

  // =====================================================
  // PASSO 2 - Ping CRIPTOGRAFADO
  // =====================================================
  if (action === "ping") {
    const responsePayloadPing = {
      data: { status: "active" }
    };
    const encryptedResponsePing = encryptFlowResponse(
      responsePayloadPing,
      aesKeyBuffer,
      initialVectorBuffer
    );
    return res.status(200).type("text/plain").send(encryptedResponsePing);
  }

  // Aceitamos apenas estas ações no roteamento principal
  if (!["INIT", "BACK", "data_exchange"].includes(action)) {
    console.warn("[FLOW DATA] Ação não suportada:", action);
    const responsePayloadInvalid = {
      version,
      screen: currentScreen,
      data: {
        error_message: `Ação não suportada: ${action}`
      }
    };
    const encryptedResponseInvalid = encryptFlowResponse(
      responsePayloadInvalid,
      aesKeyBuffer,
      initialVectorBuffer
    );
    return res.status(200).type("text/plain").send(encryptedResponseInvalid);
  }

  // =====================================================
  // PASSO 3 - Roteamento por Tela (Cenários A–F)
  // =====================================================
  let responsePayload;

  try {
    // ---------------------------------------------
    // CENÁRIO A: Tela 0 – EMPRESA_SELECT_SCREEN
    // ---------------------------------------------
    if (currentScreen === "EMPRESA_SELECT_SCREEN") {
      if (action === "INIT" || action === "BACK") {
        // Lista de empresas
        const { data: empresasDb, error } = await supabase
          .from("empresas")
          .select("id, nome, endereco_resumo")
          .eq("ativo", true)
          .order("nome", { ascending: true });

        if (error) {
          console.error("[FLOW DATA] Erro ao buscar empresas:", error);
          responsePayload = {
            version,
            screen: "EMPRESA_SELECT_SCREEN",
            data: {
              empresas: [],
              error_message: "Erro ao buscar empresas. Tente novamente."
            }
          };
        } else {
          const empresas =
            (empresasDb || []).map((e) => ({
              id: String(e.id),
              title: e.nome || "Empresa sem nome",
              description: e.endereco_resumo || ""
            })) || [];

          console.log(
            `[FLOW DATA] EMPRESA_SELECT_SCREEN → ${empresas.length} empresa(s) retornada(s).`
          );

          responsePayload = {
            version,
            screen: "EMPRESA_SELECT_SCREEN",
            data: { empresas }
          };
        }
      } else if (action === "data_exchange") {
        // Usuário escolheu uma empresa
        const empresaId =
          dataIn.empresa_id ||
          payloadIn.empresa_id ||
          screenState.EMPRESA_SELECT_SCREEN?.data?.empresa_id ||
          null;

        console.log(
          "[FLOW DATA] EMPRESA_SELECT_SCREEN → empresa escolhida:",
          empresaId
        );

        if (!empresaId) {
          responsePayload = {
            version,
            screen: "EMPRESA_SELECT_SCREEN",
            data: {
              error_message:
                "Não foi possível identificar a empresa selecionada. Tente novamente."
            }
          };
        } else {
          const { data: empresaDb, error: empresaError } = await supabase
            .from("empresas")
            .select("id, nome, descricao_complexo")
            .eq("id", empresaId)
            .eq("ativo", true)
            .single();

          if (empresaError || !empresaDb) {
            console.error(
              "[FLOW DATA] Erro ao buscar dados do complexo:",
              empresaError
            );
            responsePayload = {
              version,
              screen: "EMPRESA_SELECT_SCREEN",
              data: {
                error_message:
                  "Não foi possível carregar o complexo selecionado. Tente novamente."
              }
            };
          } else {
            const titulo = empresaDb.nome || "Complexo selecionado";
            const descricao =
              empresaDb.descricao_complexo ||
              "Informações do complexo em breve.";

            // 👉 NÃO enviamos lista de quadras aqui.
            responsePayload = {
              version,
              screen: "COMPLEXO_DETAIL_SCREEN",
              data: {
                empresa_id: String(empresaDb.id),
                titulo,
                descricao
              }
            };
          }
        }
      }
    }

    // ---------------------------------------------
    // CENÁRIO B: Tela 1 – COMPLEXO_DETAIL_SCREEN
    // (Usuário clicou em "Escolher Quadra")
    // ---------------------------------------------
    else if (currentScreen === "COMPLEXO_DETAIL_SCREEN") {
      if (action === "data_exchange") {
        const empresaId =
          payloadIn.empresa_id ||
          dataIn.empresa_id ||
          screenState.COMPLEXO_DETAIL_SCREEN?.data?.empresa_id ||
          screenState.EMPRESA_SELECT_SCREEN?.data?.empresa_id ||
          null;

        console.log(
          "[FLOW DATA] COMPLEXO_DETAIL_SCREEN → data_exchange para empresa:",
          empresaId
        );

        if (!empresaId) {
          responsePayload = {
            version,
            screen: "COMPLEXO_DETAIL_SCREEN",
            data: {
              error_message:
                "Não foi possível identificar o complexo selecionado. Volte e tente novamente."
            }
          };
        } else {
          const { data: quadrasDb, error: quadrasError } = await supabase
            .from("quadras")
            .select("id, tipo, material, modalidade")
            .eq("empresa_id", empresaId)
            .eq("status", "ativa")
            .order("tipo", { ascending: true });

          if (quadrasError) {
            console.error(
              "[FLOW DATA] COMPLEXO_DETAIL_SCREEN → erro ao buscar quadras:",
              quadrasError
            );
            responsePayload = {
              version,
              screen: "COMPLEXO_DETAIL_SCREEN",
              data: {
                error_message:
                  "Não foi possível carregar as quadras agora. Tente novamente."
              }
            };
          } else {
            const quadras =
              (quadrasDb || []).map((q) => {
                const partes = [
                  q.tipo || "",
                  q.material || "",
                  q.modalidade || ""
                ]
                  .map((s) => String(s).trim().toUpperCase())
                  .filter(Boolean);

                return {
                  id: String(q.id),
                  title: partes.join(" "),
                  description: ""
                };
              }) || [];

            console.log(
              "[FLOW DATA] COMPLEXO_DETAIL_SCREEN →",
              quadras.length,
              "quadra(s) encontrada(s) para empresa:",
              empresaId
            );

            responsePayload = {
              version,
              screen: "QUADRA_SELECT_SCREEN",
              data: {
                empresa_id: String(empresaId),
                quadras
              }
            };
          }
        }
      } else {
        // INIT / BACK → apenas ecoar dados
        responsePayload = buildFlowResponsePayload(
          decryptedBody,
          "COMPLEXO_DETAIL_SCREEN",
          dataIn
        );
        responsePayload.version = version;
      }
    }

    // ---------------------------------------------
    // CENÁRIO C: Tela 2 – QUADRA_SELECT_SCREEN
    // (Usuário escolheu uma quadra)
    // ---------------------------------------------
    else if (currentScreen === "QUADRA_SELECT_SCREEN") {
      if (action === "data_exchange") {
        const empresaId =
          dataIn.empresa_id ||
          payloadIn.empresa_id ||
          screenState.QUADRA_SELECT_SCREEN?.data?.empresa_id ||
          screenState.COMPLEXO_DETAIL_SCREEN?.data?.empresa_id ||
          null;

        const quadraId =
          dataIn.quadra_id ||
          payloadIn.quadra_id ||
          null;

        console.log(
          "[FLOW DATA] QUADRA_SELECT_SCREEN → empresa:",
          empresaId,
          "| quadra selecionada:",
          quadraId
        );

        if (!quadraId) {
          responsePayload = {
            version,
            screen: "QUADRA_SELECT_SCREEN",
            data: {
              empresa_id: empresaId,
              error_message:
                "Não foi possível identificar a quadra selecionada. Tente novamente."
            }
          };
        } else {
          const { data: quadraDb, error: quadraError } = await supabase
  .from("quadras")
  .select(
    "id, aviso, tipo, material, modalidade, status, empresa_id, empresas(nome)"
  )
  .eq("id", quadraId)
  .eq("status", "ativa") // garante que não agenda quadra desativada
  .maybeSingle();


          if (quadraError || !quadraDb) {
            console.error(
              "[FLOW DATA] QUADRA_SELECT_SCREEN → erro ao buscar quadra:",
              quadraError
            );
            responsePayload = {
              version,
              screen: "QUADRA_SELECT_SCREEN",
              data: {
                empresa_id: empresaId,
                error_message:
                  "Não foi possível carregar os detalhes da quadra. Tente novamente."
              }
            };
          } else {
            const nomeEmpresa =
              quadraDb.empresas?.nome || "Quadra selecionada";

            const partesNome = [
              quadraDb.tipo || "",
              quadraDb.material || "",
              quadraDb.modalidade || ""
            ]
              .map((s) => String(s).trim().toUpperCase())
              .filter(Boolean);

            const nomeQuadra =
              partesNome.join(" ") || "Quadra selecionada";

            const quadra = {
              id: String(quadraDb.id),
              nome: nomeQuadra,
              aviso: quadraDb.aviso || "",
              endereco: "",
              foto: "",
              link_google_maps: ""
            };

            responsePayload = {
              version,
              screen: "QUADRA_DETAIL_SCREEN",
              data: {
                empresa_id: String(
                  quadraDb.empresa_id || empresaId || ""
                ),
                quadra_id: String(quadraDb.id),
                titulo: nomeEmpresa,
                quadra
              }
            };
          }
        }
      } else {
        // INIT / BACK → mantém dados atuais
        responsePayload = buildFlowResponsePayload(
          decryptedBody,
          "QUADRA_SELECT_SCREEN",
          dataIn
        );
        responsePayload.version = version;
      }
    }

    // ---------------------------------------------
    // CENÁRIO D: Tela 3 – QUADRA_DETAIL_SCREEN
    // (Usuário clicou em "Agendar")
    // ---------------------------------------------
    else if (currentScreen === "QUADRA_DETAIL_SCREEN") {
      if (action === "data_exchange") {
        const quadraId =
          dataIn.quadra_id ||
          payloadIn.quadra_id ||
          (dataIn.quadra && dataIn.quadra.id) ||
          null;

        const empresaId =
          dataIn.empresa_id ||
          payloadIn.empresa_id ||
          screenState.QUADRA_DETAIL_SCREEN?.data?.empresa_id ||
          screenState.QUADRA_SELECT_SCREEN?.data?.empresa_id ||
          null;

        console.log(
          "[FLOW DATA] QUADRA_DETAIL_SCREEN → Agendar quadra:",
          quadraId,
          "empresa:",
          empresaId
        );

        responsePayload = {
          version,
          screen: "DATE_TIME_SCREEN",
          data: {
            empresa_id: empresaId ? String(empresaId) : "",
            quadra_id: quadraId ? String(quadraId) : "",
            data_agendamento: "",
            horarios: []
          }
        };
      } else {
        // INIT / BACK → ecoa dados
        responsePayload = buildFlowResponsePayload(
          decryptedBody,
          "QUADRA_DETAIL_SCREEN",
          dataIn
        );
        responsePayload.version = version;
      }
    }

    // ---------------------------------------------
    // CENÁRIO E: Tela 4 – DATE_TIME_SCREEN
    // ---------------------------------------------
    else if (currentScreen === "DATE_TIME_SCREEN") {
      const quadraId =
        dataIn.quadra_id ||
        payloadIn.quadra_id ||
        screenState.DATE_TIME_SCREEN?.data?.quadra_id ||
        screenState.QUADRA_DETAIL_SCREEN?.data?.quadra_id ||
        null;

      const dataAgendamento =
        dataIn.data_agendamento ||
        payloadIn.data_agendamento ||
        screenState.DATE_TIME_SCREEN?.data?.data_agendamento ||
        "";

      const horarioId =
        dataIn.horario_id ||
        payloadIn.horario_id ||
        null;

      console.log(
        "[FLOW DATA] DATE_TIME_SCREEN → quadraId=",
        quadraId,
        "data_agendamento=",
        dataAgendamento,
        "horarioId=",
        horarioId
      );

      // 1) Usuário escolheu/alterou a DATA → buscar horários
      // Se não tem horarioId ou se a ação for explicitamente troca de data
      if (action === "data_exchange" && quadraId && dataAgendamento && !horarioId) {
        let horarios = [];

        try {
          const [anoStr, mesStr, diaStr] = String(dataAgendamento).split("-");
          const ano = parseInt(anoStr, 10);
          const mes = parseInt(mesStr, 10);
          const dia = parseInt(diaStr, 10);

          const dt = new Date(ano, mes - 1, dia);
          const diaSemana = dt.getDay(); // 0=Dom ... 6=Sáb

          console.log(
            `[FLOW DATA] DATE_TIME_SCREEN → Buscando regras para diaSemana=${diaSemana}`
          );

          const { data: regras, error: regrasError } = await supabase
            .from("regras_horarios")
            .select("id, hora_inicio, hora_fim, valor")
            .eq("id_quadra", quadraId)
            .eq("dia_da_semana", diaSemana)
            .order("hora_inicio", { ascending: true });

          if (regrasError) {
            console.error(
              "[FLOW DATA] DATE_TIME_SCREEN → Erro SQL:",
              regrasError
            );
          } else {
            // CORREÇÃO CRÍTICA: Mapeia para 'title' e 'description'
            horarios = (regras || []).map((r) => ({
              id: String(r.id),
              title: `${r.hora_inicio.slice(0, 5)} - ${r.hora_fim.slice(0, 5)}`,
              description: `R$ ${Number(r.valor).toFixed(2)}`
            }));
          }
        } catch (errDt) {
          console.error("[FLOW DATA] Erro data:", errDt);
        }

        console.log(
          `[FLOW DATA] DATE_TIME_SCREEN → ${horarios.length} horários encontrados.`
        );

        responsePayload = {
          version,
          screen: "DATE_TIME_SCREEN",
          data: {
            quadra_id: String(quadraId),
            data_agendamento: dataAgendamento,
            horarios // Array preenchido corretamente
          }
        };
      }
      // 2) Usuário escolheu horário → Vai para CADASTRO
      else if (action === "data_exchange" && horarioId) {
        console.log("[FLOW DATA] DATE_TIME_SCREEN → Avançando para CADASTRO_SCREEN");
        responsePayload = {
          version,
          screen: "CADASTRO_SCREEN",
          data: {
            quadra_id: String(quadraId),
            data_agendamento: dataAgendamento,
            horario_id: String(horarioId)
          }
        };
      }
      // 3) Fallback (INIT/BACK)
      else {
        responsePayload = buildFlowResponsePayload(
          decryptedBody,
          "DATE_TIME_SCREEN",
          {
            quadra_id: quadraId ? String(quadraId) : "",
            data_agendamento: dataAgendamento || "",
            horarios: []
          }
        );
        responsePayload.version = version;
      }
    }

    // ---------------------------------------------
    // CENÁRIO F: Outras telas (CADASTRO, REVIEW)
    // – apenas ecoar dados
    // ---------------------------------------------
    else if (
      currentScreen === "CADASTRO_SCREEN" ||
      currentScreen === "REVIEW_SCREEN"
    ) {
      responsePayload = buildFlowResponsePayload(
        decryptedBody,
        currentScreen,
        dataIn
      );
      responsePayload.version = version;
    }

    // ---------------------------------------------
    // Fallback geral – se nenhuma tela casou
    // ---------------------------------------------
    if (!responsePayload) {
      console.warn(
        "[FLOW DATA] Nenhum cenário casou. currentScreen =",
        currentScreen
      );
      responsePayload = buildFlowResponsePayload(
        decryptedBody,
        currentScreen,
        dataIn
      );
      responsePayload.version = version;
    }
  } catch (err) {
    console.error("[FLOW DATA] ERRO interno no roteamento:", err);

    // Se já temos chave AES, devolve erro criptografado
    if (aesKeyBuffer && initialVectorBuffer) {
      const fallbackPayload = {
        version,
        screen: currentScreen,
        data: {
          error_message:
            "Erro interno ao processar o fluxo. Tente novamente em alguns instantes."
        }
      };
      const encryptedFallback = encryptFlowResponse(
        fallbackPayload,
        aesKeyBuffer,
        initialVectorBuffer
      );
      return res.status(200).type("text/plain").send(encryptedFallback);
    }

    // Sem AES (situação bem rara): JSON simples
    return res
      .status(500)
      .json({ ok: false, error: "Erro interno em /flow-data." });
  }

  // =====================================================
  // PASSO 4 - Encrypt & Responder
  // =====================================================
  const encryptedResponse = encryptFlowResponse(
    responsePayload,
    aesKeyBuffer,
    initialVectorBuffer
  );
  return res.status(200).type("text/plain").send(encryptedResponse);
});



// -----------------------------------------
// 11. WEBHOOK POST (mensagens)
// -----------------------------------------
app.post("/webhook", async (req, res) => {
  if (!isValidSignature(req)) {
    return res.sendStatus(403);
  }

  try {
    const body = req.body;
    console.log("[WEBHOOK POST] body = ", JSON.stringify(body, null, 2));

    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    if (!entry) {
      return res.sendStatus(200);
    }

    const messages = entry.messages || [];
    const statuses = entry.statuses || [];

    // Se for só status (entrega, leitura, etc.)
    if (!messages.length && statuses.length > 0) {
      console.log("[WEBHOOK POST] Tipo de mensagem não tratado: status");
      return res.sendStatus(200);
    }

    if (!messages.length) {
      console.log("[WEBHOOK POST] Sem mensagens para processar.");
      return res.sendStatus(200);
    }

    const msg = messages[0];
    const waId = msg.from;
    const msgType = msg.type;
    const msgBody = msg.text?.body || "";
    const interactive = msg.interactive || {};
    const session = getSession(waId);

    const textoNormalizado = (msgBody || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const gatilhosSaudacao = [
      "oi",
      "ola",
      "opa",
      "e ai",
      "eae",
      "fala",
      "bom dia",
      "boa tarde",
      "boa noite",
      "tudo bem",
      "blz",
      "beleza",
      "menu",
      "inicio",
      "início"
    ];

    const gatilhosAgendamento = [
      "agendar",
      "reserva",
      "reservar",
      "quadra",
      "horario",
      "horário",
      "jogar",
      "marcar"
    ];

 // ------------------------------------------------------
// 1) MENSAGENS DE TEXTO (oi, menu, números, etc.)
// ------------------------------------------------------
if (msgType === "text") {
  // Texto cru vindo do WhatsApp
  const textoRaw = msgBody || "";
  const texto = textoRaw.trim();

  // Normalização (minúsculo, sem acento)
  const textoNormalizado = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Pega a sessão do usuário
  const session = getSession(waId);

  // --------------------------------------------------
  // 1.0 - Se estamos aguardando CPF para "Meus agendamentos"
  // --------------------------------------------------
  if (session.state === "AGUARDANDO_CPF_MEUS_AGENDAMENTOS") {
    const cpfSomenteNumeros = (textoNormalizado || "").replace(/\D/g, "");

    // validação simples: 11 dígitos
    if (cpfSomenteNumeros.length !== 11) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "CPF inválido. Digite *apenas os 11 números* do CPF (sem pontos e traço)."
        )
      );
      return res.sendStatus(200);
    }

    await enviarResumoAgendamentos(waId, cpfSomenteNumeros);

    // limpa estado para não ficar preso
    session.state = null;

    return res.sendStatus(200);
  }

    // Gatilhos de saudação / menu / agendamento
  const gatilhosSaudacao = [
    "oi",
    "ola",
    "opa",
    "e ai",
    "eae",
    "fala",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "blz",
    "beleza",
    "menu",
    "inicio",
    "início"
  ];

  const gatilhosAgendamento = [
    "agendar",
    "reserva",
    "reservar",
    "quadra",
    "horario",
    "horário",
    "jogar",
    "marcar"
  ];

  // --------------------------------------------------
  // 1.1 - Estado: LISTANDO_COMPLEXOS (nível 1)
  // --------------------------------------------------
  if (session.state === "LISTANDO_COMPLEXOS") {
    if (textoNormalizado === "menu") {
      resetSessionNavigation(session);
      const welcomeMsg = await buildWelcomeMenuMessage(waId);
      await callWhatsAppAPI(welcomeMsg);
      return res.sendStatus(200);
    }

    const numero = textoNormalizado.replace(/[^0-9]/g, "");
    if (!numero) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Por favor, digite apenas o *número do complexo* ou 'menu' para voltar."
        )
      );
      return res.sendStatus(200);
    }

    const idx = parseInt(numero, 10) - 1;
    if (
      Number.isNaN(idx) ||
      idx < 0 ||
      !session.empresasList ||
      idx >= session.empresasList.length
    ) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Número inválido. Digite o número de um complexo da lista ou 'menu' para voltar."
        )
      );
      return res.sendStatus(200);
    }

    const empresa = session.empresasList[idx];
    await sendQuadrasDoComplexo(waId, empresa);
    return res.sendStatus(200);
  }

  // --------------------------------------------------
  // 1.2 - Estado: LISTANDO_QUADRAS_DO_COMPLEXO (nível 2)
  // --------------------------------------------------
  if (session.state === "LISTANDO_QUADRAS_DO_COMPLEXO") {
    if (textoNormalizado === "menu") {
      resetSessionNavigation(session);
      const welcomeMsg = await buildWelcomeMenuMessage(waId);
      await callWhatsAppAPI(welcomeMsg);
      return res.sendStatus(200);
    }

    const numero = textoNormalizado.replace(/[^0-9]/g, "");
    if (!numero) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Digite o *número da quadra* ou '0' para voltar aos complexos, ou 'menu' para o início."
        )
      );
      return res.sendStatus(200);
    }

    // "0" = voltar para lista de complexos
    if (numero === "0") {
      await sendEmpresasListFromSupabase(waId);
      return res.sendStatus(200);
    }

    const idx = parseInt(numero, 10) - 1;
    if (
      Number.isNaN(idx) ||
      idx < 0 ||
      !session.quadrasList ||
      idx >= session.quadrasList.length
    ) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Número de quadra inválido. Escolha um número da lista, '0' para voltar ou 'menu' para o início."
        )
      );
      return res.sendStatus(200);
    }

    const quadraResumo = session.quadrasList[idx];

    const { data: quadraFull, error: qErr } = await supabase
      .from("quadras")
      .select("*")
      .eq("id", quadraResumo.id)
      .single();

    if (qErr || !quadraFull) {
      console.error("[SUPABASE] Erro ao carregar detalhes da quadra:", qErr);
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Não consegui carregar os detalhes dessa quadra agora. Tente novamente em instantes."
        )
      );
      return res.sendStatus(200);
    }

    await sendQuadraDetailsWithPhoto(waId, quadraFull);
    return res.sendStatus(200);
  }

  // --------------------------------------------------
  // 1.3 - Compatibilidade com estado antigo LISTANDO_QUADRAS
  // --------------------------------------------------
  if (session.state === "LISTANDO_QUADRAS") {
    const numero = textoNormalizado.replace(/[^0-9]/g, "");
    if (!numero) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Por favor, responda apenas com o *número* da quadra que você quer conhecer 🙂"
        )
      );
      return res.sendStatus(200);
    }

    const index = parseInt(numero, 10) - 1;
    const lista = session.quadrasList || [];

    if (!lista[index]) {
      await callWhatsAppAPI(
        buildTextMessage(
          waId,
          "Número inválido. Escolha um dos números da lista que eu enviei 🙂"
        )
      );
      return res.sendStatus(200);
    }

    const quadraResumo = lista[index];

    const { data: quadraFull, error } = await supabase
      .from("quadras")
      .select("*")
      .eq("id", quadraResumo.id)
      .single();

    if (error || !quadraFull) {
      console.error("[SUPABASE] Erro ao buscar quadra completa:", error);
      await sendQuadraDetailsWithPhoto(waId, quadraResumo);
    } else {
      await sendQuadraDetailsWithPhoto(waId, quadraFull);
    }

    return res.sendStatus(200);
  }

  // --------------------------------------------------
  // 1.4 - Saudações / "menu" / gatilhos gerais → card inicial
  // --------------------------------------------------
  const temSaudacaoOuMenu = gatilhosSaudacao.some((g) =>
    textoNormalizado.includes(g)
  );
  const temAgendamento = gatilhosAgendamento.some((g) =>
    textoNormalizado.includes(g)
  );

  if (temSaudacaoOuMenu || temAgendamento) {
    resetSessionNavigation(session);

    const welcomeMsg = await buildWelcomeMenuMessage(waId);
    await callWhatsAppAPI(welcomeMsg);

    return res.sendStatus(200);
  }

  // 1.5 - Se não caiu em nada acima, deixa seguir para o resto do fluxo
  //       (Flows, PIX, etc.) que já existe abaixo neste handler.
}


    // ------------------------------------------------------
    // 2) BOTÕES "button_reply"
    // ------------------------------------------------------
    if (
  msgType === "interactive" &&
  interactive &&
  interactive.type === "button_reply" &&
  interactive.button_reply
) {
  const buttonId = interactive.button_reply.id;
  console.log("[WEBHOOK POST] Botão clicado:", buttonId);

  try {
    // 2.1 - Novo botão do menu inicial: ONDE JOGAR
    if (buttonId === "BTN_MENU_ONDE_JOGAR") {
      await sendEmpresasListFromSupabase(waId);
      return res.sendStatus(200);
    }

    // 2.2 - Ver outra quadra (volta para o nível 2 - quadras do mesmo complexo)
    if (buttonId === "BTN_VER_OUTRA_QUADRA") {
      const session = getSession(waId);
      if (!session.empresaSelecionada) {
        // fallback: volta para lista de complexos
        await sendEmpresasListFromSupabase(waId);
      } else {
        await sendQuadrasDoComplexo(waId, session.empresaSelecionada);
      }
      return res.sendStatus(200);
    }

    // 2.3 - Menu Principal (volta para o card de boas-vindas)
    if (buttonId === "BTN_MENU_PRINCIPAL") {
      const session = getSession(waId);
      resetSessionNavigation(session);
      const welcomeMsg = await buildWelcomeMenuMessage(waId);
      await callWhatsAppAPI(welcomeMsg);
      return res.sendStatus(200);
    }

    // 2.4 - Agendar quadra (abre Flow de agendamento) – mantém lógica antiga
    if (buttonId === "BTN_AGENDAR_QUADRA") {
      const flowToken = crypto.randomBytes(16).toString("hex");

      const flowMsg = buildFlowOpenMessage(
        waId,
        FLOW_ID_AGENDAMENTO,
        "Confirmo",
        flowToken,
        null,
        null,
        null
      );

      await callWhatsAppAPI(flowMsg);
      return res.sendStatus(200);
    }

    // 2.5 - Meus agendamentos (mantém como já estava)
    if (buttonId === "BTN_MEUS_AGENDAMENTOS") {
  const session = getSession(waId);
  session.state = "AGUARDANDO_CPF_MEUS_AGENDAMENTOS"; // 👈 marca que agora esperamos CPF

  await callWhatsAppAPI(
    buildTextMessage(
      waId,
      "Digite seu CPF (apenas números) para consultar seus agendamentos:"
    )
  );

  return res.sendStatus(200);
}


    // se for algum outro botão que você já trata em outro lugar, mantém aqui
  } catch (err) {
    console.error("[WEBHOOK POST] Erro ao processar botão:", err);
    await callWhatsAppAPI(
      buildTextMessage(
        waId,
        "Tive um problema ao processar sua solicitação. Tente novamente."
      )
    );
    return res.sendStatus(200);
  }
}


    // ------------------------------------------------------
    // 3) RESPOSTA DOS FLOWS (NFM REPLY) — mantém IGUAL estava
    // ------------------------------------------------------
    if (
      msgType === "interactive" &&
      interactive &&
      interactive.type === "nfm_reply" &&
      interactive.nfm_reply
    ) {
      let payload = {};
      try {
        payload = JSON.parse(interactive.nfm_reply.response_json || "{}");
      } catch (e) {
        console.error("[FLOW NFM] Erro ao parsear response_json:", e);
        await callWhatsAppAPI(
          buildTextMessage(
            waId,
            "Não consegui ler os dados do fluxo. Tente novamente."
          )
        );
        return res.sendStatus(200);
      }

      const flowToken = payload.flow_token || null;
      console.log("[FLOW NFM] flowToken =", flowToken);
      console.log("[FLOW NFM] payload =", payload);

      // Flow "Meus agendamentos"
      if (flowToken === "vaiterplay-meus-agendamentos") {
        const cpf = payload.cpf || null;
        if (!cpf) {
          console.error("[FLOW MeusAg] CPF não encontrado no payload:", payload);
          await callWhatsAppAPI(
            buildTextMessage(waId, "CPF não informado. Tente novamente.")
          );
        } else {
          await enviarResumoAgendamentos(waId, cpf);
        }
        return res.sendStatus(200);
      }

            // Flow de agendamento (PIX, Supabase, etc.)
      // Aceita se o token bater OU se o payload tiver a flag de finalização explícita
      if (flowToken === "vaiterplay-agendamento" || payload.finalizado) {
        console.log(
          "[FLOW Agendamento] Flow de agendamento finalizado (finalizado =",
          payload.finalizado,
          ")"
        );

        // Se ainda não estiver finalizado, não faz nada
        if (!payload.finalizado) {
          return res.sendStatus(200);
        }

        const {
          quadra_id,
          data_agendamento,
          horario_id,
          nome_completo,
          cpf
        } = payload;

        console.log("[FLOW Agendamento] Dados recebidos:", {
          quadra_id,
          data_agendamento,
          horario_id,
          nome_completo,
          cpf
        });

        // 1) Valida data vinda do Flow
        const dataObj = parseDataAgendamentoBr(data_agendamento);
        if (!dataObj) {
          await callWhatsAppAPI(
            buildTextMessage(
              waId,
              "Não consegui entender a data escolhida. Use um formato como 20/11/2025 ou escolha novamente no calendário."
            )
          );
          return res.sendStatus(200);
        }

        // 2) Garante janela de 0–60 dias
        try {
          const hoje = new Date();
          hoje.setHours(0, 0, 0, 0);
          const dataLimpa = new Date(dataObj.getTime());
          const diffMs = dataLimpa.getTime() - hoje.getTime();
          const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));

          if (Number.isNaN(diffDias) || diffDias < 0 || diffDias > 60) {
            await callWhatsAppAPI(
              buildTextMessage(
                waId,
                "Para agendar, usamos apenas datas entre hoje e os próximos 60 dias. Escolha outra data e tente novamente."
              )
            );
            return res.sendStatus(200);
          }
        } catch (e) {
          console.error("[FLOW Agendamento] Erro ao validar data:", e);
        }

        // 3) Validação básica de campos obrigatórios
        if (
          !quadra_id ||
          !data_agendamento ||
          !horario_id ||
          !nome_completo ||
          !cpf
        ) {
          console.error(
            "[FLOW Agendamento] Payload incompleto, não vou salvar:",
            payload
          );
          await callWhatsAppAPI(
            buildTextMessage(
              waId,
              "Tivemos um problema ao receber todos os dados do agendamento. Por favor, tente novamente."
            )
          );
          return res.sendStatus(200);
        }

        try {
          // 4) Garante usuário no Supabase
          const usuario = await upsertUsuario({
            nome_completo,
            cpf,
            waId
          });

          // 5) Busca regra de horário e normaliza data
          const regra = await buscarRegraHorario(horario_id);
          const dataIso = formatDateISO(dataObj);

          // 6) Cria agendamento como PENDING
          const agendamento = await criarAgendamento({
            id_usuario: usuario,
            id_quadra: quadra_id,
            data_agendamento: dataIso,
            regra,
            waId,
            cpf
          });

          // 7) Busca quadra + empresa (join) para montar os textos
          let quadraComEmpresa = null;
          try {
            const { data: qJoin, error: qError } = await supabase
              .from("quadras")
              .select("*, empresas ( nome )")
              .eq("id", quadra_id)
              .single();

            if (qError) {
              console.error(
                "[FLOW Agendamento] Erro ao buscar quadra+empresa:",
                qError
              );
            } else {
              quadraComEmpresa = qJoin;
            }
          } catch (e) {
            console.error(
              "[FLOW Agendamento] Exceção ao buscar quadra+empresa:",
              e
            );
          }

          // Fallback: se o join falhar, busca só a quadra
          if (!quadraComEmpresa) {
            quadraComEmpresa = await buscarQuadra(quadra_id);
          }

          const quadra = quadraComEmpresa || {};

          // 8) Monta nome do complexo e da quadra no padrão da Tela 2
          const empresaNome =
          (quadra.empresas && quadra.empresas.nome) ||
           quadra.nome_complexo ||
           quadra.nome_empresa ||
           "Complexo não informado";

          // Nome dinâmico da quadra (TIPO + MATERIAL + MODALIDADE)
          const quadraNomeComposto = buildNomeQuadraDinamico(quadra);

          // 9) Formata data (DD/MM/AAAA) e hora (HH:mm)
          let dataBr = data_agendamento;
          try {
            const [ano, mes, dia] = String(agendamento.data)
              .slice(0, 10)
              .split("-");
            if (ano && mes && dia) {
              dataBr = `${dia}/${mes}/${ano}`;
            }
          } catch (e) {
            console.error("[FLOW Agendamento] Erro ao formatar data BR:", e);
          }

          const horaStr =
            (agendamento.hora && agendamento.hora.slice(0, 5)) ||
            (regra.hora_inicio && regra.hora_inicio.slice(0, 5)) ||
            "";

          const telefoneUsuario = payload.telefone || waId;
          const cpfFormatado = normalizarCpf(cpf) || cpf;

                    // 10) Calcula data de expiração do PIX (30 minutos a partir de agora)
          const expirationDate = new Date(
            Date.now() + 30 * 60 * 1000 // 30 min em ms
          ).toISOString();

          // 10.1) Monta dados do payer (boas práticas Mercado Pago)
          const nomeSeguro = (nome_completo || "Cliente VaiTerPlay").trim();
          const partesNome = nomeSeguro.split(/\s+/);
          const firstName = partesNome[0] || "Cliente";
          const lastName =
            partesNome.length > 1
              ? partesNome[partesNome.length - 1]
              : "VaiTerPlay";

          // 10.2) Cria pagamento PIX no Mercado Pago com data_of_expiration
          const payment = await mpPayment.create({
            body: {
              transaction_amount: Number(regra.valor),
              description: `Reserva VaiTerPlay - ${quadraNomeComposto}`,
              payment_method_id: "pix",
              date_of_expiration: expirationDate, // 👈 expira em 30 min
              payer: {
                // Pode trocar por um e-mail real no futuro
                email: "cliente@vaiterplay.com",
                first_name: firstName,
                last_name: lastName
              }
            }
          });


          const p = payment.response || payment;

          const qrCode =
            p.point_of_interaction?.transaction_data?.qr_code_base64;
          const pixKey =
            p.point_of_interaction?.transaction_data?.qr_code;

          // 11) Salva o id da transação PIX na reserva (para o webhook localizar depois)
            await supabase
              .from("reservas")
              .update({ id_transacao_pix: String(p.id), pago_via_pix: true })
              .eq("id", agendamento.id);


          // 12) PRIMEIRA mensagem: resumo para conferência
          const mensagemResumo =
            "📝 *Confira sua reserva antes de pagar*\n\n" +
            `🏟️ Complexo: ${empresaNome}\n` +
            `⚽ Quadra: ${quadraNomeComposto}\n` +
            `📅 Data: ${dataBr}\n` +
            (horaStr ? `⏰ Hora: ${horaStr}\n` : "") +
            `👤 Responsável: ${nome_completo}\n` +
            `🆔 CPF: ${cpfFormatado}\n` +
            `📱 Telefone: ${telefoneUsuario}\n\n` +
            "⚠️ *Dados incorretos? Não pague este código. Faça um novo agendamento.*";

          await callWhatsAppAPI(buildTextMessage(waId, mensagemResumo));

          // 13) SEGUNDA mensagem: instruções PIX (mantém CMS atual)
          const pixInstrucaoDefault =
            "✅ PIX gerado!\n\n" +
            "Vou te enviar a chave PIX em uma mensagem separada, logo abaixo.\n\n" +
            "1) Toque e segure na mensagem com o código PIX\n" +
            '2) Toque em "Copiar"\n' +
            "3) Cole no app do seu banco para pagar\n\n" +
            "Assim que o pagamento for confirmado pelo banco/Mercado Pago,\n" +
            "você receberá automaticamente uma mensagem de confirmação aqui no WhatsApp.";

          const mensagemPixInstrucoes = await getMensagemWhatsapp({
            chave: "PIX_INSTRUCOES",
            contexto: "whatsapp_pix",
            defaultText: pixInstrucaoDefault,
            // hoje vamos tratar como global; no futuro podemos usar quadra/gestor
            gestorId: null,
            quadraId: quadra?.id || agendamento.quadra_id || null
          });

          await callWhatsAppAPI(
            buildTextMessage(waId, mensagemPixInstrucoes)
          );

          // 14) TERCEIRA mensagem: somente a chave PIX (mais fácil de copiar)
          if (pixKey) {
            await callWhatsAppAPI(buildTextMessage(waId, pixKey));
          } else {
            const pixErroDefault =
              "Não consegui obter a chave PIX. Tente novamente em alguns instantes.";

            const mensagemPixErro = await getMensagemWhatsapp({
              chave: "PIX_ERRO_CHAVE",
              contexto: "whatsapp_pix",
              defaultText: pixErroDefault,
              gestorId: null,
              quadraId: quadra?.id || agendamento.quadra_id || null
            });

            await callWhatsAppAPI(buildTextMessage(waId, mensagemPixErro));
          }

          return res.sendStatus(200);
        } catch (err) {
          console.error("[FLOW Agendamento] Erro ao processar agendamento:", err);

          if (err && err.code === "HORARIO_INDISPONIVEL") {
            await callWhatsAppAPI(
              buildTextMessage(
                waId,
                "Este horário acabou de ser reservado por outra pessoa. Volte e escolha outro horário."
              )
            );
          } else {
            await callWhatsAppAPI(
              buildTextMessage(
                waId,
                "Tivemos um erro interno ao salvar seu agendamento. Tente novamente em alguns instantes."
              )
            );
          }

          return res.sendStatus(200);
        }
      }


      console.log("[FLOW NFM] Flow token não tratado:", flowToken);
      return res.sendStatus(200);
    }

    console.log("[WEBHOOK POST] Tipo de mensagem não tratado:", msgType);
    return res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK POST] Erro geral:", err);
    return sendError(res, 500, "Erro inesperado", { detail: err.message });
  }
});

// =========================================
// 11. Dashboards (Admin / Gestor)
// =========================================

// Pequeno helper para gerar array de datas 'YYYY-MM-DD' entre dois limites (inclusive)
function buildDateArray(fromStr, toStr) {
  const result = [];
  const start = new Date(fromStr);
  const end = new Date(toStr);

  // Normaliza para meia-noite UTC para evitar problemas de fuso
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    result.push(d.toISOString().slice(0, 10)); // 'YYYY-MM-DD'
  }
  return result;
}

// -----------------------------------------
// Helper: Dashboard Admin - visão geral
// REGRA NOVA:
// - "Faturamento" e "Reservas pagas" contam SOMENTE:
//   origem="whatsapp" + pago_via_pix=true + status="paid"
// - Reservas do painel (origem="painel") NÃO entram no faturamento
// -----------------------------------------
async function buildAdminDashboardOverview(params) {
  const { from, to } = params || {};

  // Se não vierem datas, assume últimos 7 dias (hoje - 6 até hoje)
  const hoje = new Date();
  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(hoje.getDate() - 6);

  const fromStr =
    typeof from === "string" && from.length >= 10
      ? from.slice(0, 10)
      : seteDiasAtras.toISOString().slice(0, 10);

  const toStr =
    typeof to === "string" && to.length >= 10
      ? to.slice(0, 10)
      : hoje.toISOString().slice(0, 10);

  // 1) Busca reservas no período (somente leitura)
  // ✅ adiciona pago_via_pix + origem
  let query = supabase
    .from("reservas")
    .select(
      `
      id,
      data,
      hora,
      status,
      preco_total,
      user_cpf,
      phone,
      pago_via_pix,
      origem,
      quadras (
        id,
        tipo,
        material,
        modalidade
      )
    `
    )
    .gte("data", fromStr)
    .lte("data", toStr);

  const { data: reservas, error } = await query;

  if (error) {
    console.error("[DASHBOARD] Erro ao buscar reservas (admin):", error);
    throw error;
  }

  const reservasList = reservas || [];

  // Helper local: reserva conta como "PIX RECEBIDO"?
  // ✅ regra: whatsapp + pago_via_pix + paid
  function isPixRecebido(reserva) {
    const st = String(reserva?.status || "").toLowerCase().trim();
    const origem = String(reserva?.origem || "").toLowerCase().trim();
    const pagoViaPix = reserva?.pago_via_pix === true;

    return origem === "whatsapp" && pagoViaPix && st === "paid";
  }

  // 2) KPIs gerais
  let totalReservas = 0;
  let reservasPagasPix = 0;       // ✅ pagas via PIX (regra acima)
  let reservasPendentes = 0;
  let reservasCanceladas = 0;
  let receitaBrutaPix = 0;        // ✅ faturamento real (PIX)

  // Mapas auxiliares
  const porDia = new Map(); // dia (AAAA-MM-DD) -> { criadas, pagas_pix }
  const porQuadra = new Map(); // quadra_id -> { quadra_id, quadra_nome, reservas_pagas_pix, receita_bruta_pix }

  for (const r of reservasList) {
    totalReservas += 1;

    const status = String(r.status || "").toLowerCase().trim();
    const valor = Number(r.preco_total || 0);
    const dia = typeof r.data === "string" ? r.data.slice(0, 10) : null;

    // contadores gerais (status da reserva)
    if (status === "pending") {
      reservasPendentes += 1;
    } else if (status === "cancelled" || status === "canceled") {
      reservasCanceladas += 1;
    }

    // ✅ faturamento/“pagas” só se for PIX recebido
    const pixOk = isPixRecebido(r);
    if (pixOk) {
      reservasPagasPix += 1;
      receitaBrutaPix += valor;
    }

    // por dia – reservas criadas e pagas via pix
    if (dia) {
      if (!porDia.has(dia)) {
        porDia.set(dia, { criadas: 0, pagas_pix: 0 });
      }
      const infoDia = porDia.get(dia);
      infoDia.criadas += 1;
      if (pixOk) infoDia.pagas_pix += 1;
    }

    // por quadra – só conta pagas via pix
    const quadraId = r.quadras ? r.quadras.id : null;
    const quadraNome = buildNomeQuadraDinamico(r.quadras || null);

    if (quadraId) {
      if (!porQuadra.has(quadraId)) {
        porQuadra.set(quadraId, {
          quadra_id: quadraId,
          quadra_nome: quadraNome,
          reservas_pagas_pix: 0,
          receita_bruta_pix: 0
        });
      }
      const infoQuadra = porQuadra.get(quadraId);
      if (pixOk) {
        infoQuadra.reservas_pagas_pix += 1;
        infoQuadra.receita_bruta_pix += valor;
      }
    }
  }

  // Monta arrays ordenados por data
  const labels = buildDateArray(fromStr, toStr);
  const reservasCriadas = [];
  const reservasPagasArray = [];

  for (const dia of labels) {
    const info = porDia.get(dia) || { criadas: 0, pagas_pix: 0 };
    reservasCriadas.push(info.criadas);
    reservasPagasArray.push(info.pagas_pix);
  }

  // Top quadras – agora ordena por faturamento pix (desc)
  const vendasPorQuadra = Array.from(porQuadra.values()).sort(
    (a, b) => b.receita_bruta_pix - a.receita_bruta_pix
  );

  // Últimas reservas (até 20) — mantém como “últimas reservas do sistema”
  const ultimasReservas = reservasList
    .slice()
    .sort((a, b) => {
      const da = String(a.data || "");
      const db = String(b.data || "");
      if (da === db) {
        const ha = String(a.hora || "");
        const hb = String(b.hora || "");
        return hb.localeCompare(ha);
      }
      return db.localeCompare(da);
    })
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      data: r.data,
      hora: r.hora,
      status: r.status,
      preco_total: Number(r.preco_total || 0),
      quadra_nome: buildNomeQuadraDinamico(r.quadras || null),
      user_cpf: r.user_cpf,
      phone: r.phone,
      origem: r.origem,
      pago_via_pix: r.pago_via_pix === true
    }));

  return {
    period: { from: fromStr, to: toStr },
    kpis: {
      total_reservas: totalReservas,
      reservas_pagas: reservasPagasPix,      // ✅ agora é PIX pago
      reservas_pendentes: reservasPendentes,
      reservas_canceladas: reservasCanceladas,
      receita_bruta: receitaBrutaPix        // ✅ agora é PIX recebido
    },
    utilizacao_canal: {
      labels,
      reservas_criadas: reservasCriadas,
      reservas_pagas: reservasPagasArray     // ✅ pagas via PIX por dia
    },
    // ✅ mantém o nome para não quebrar o frontend, mas agora é baseado em PIX
    vendas_por_quadra: vendasPorQuadra.map((x) => ({
      quadra_id: x.quadra_id,
      quadra_nome: x.quadra_nome,
      reservas_pagas: x.reservas_pagas_pix,
      receita_bruta: x.receita_bruta_pix
    })),
    ultimas_reservas: ultimasReservas
  };
}


// -----------------------------------------
// Rota: Dashboard Admin - visão geral
// -----------------------------------------
app.get(
  "/admin/dashboard-overview",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { from, to } = req.query;

    const overview = await buildAdminDashboardOverview({
      from,
      to
    });

    return res.status(200).json(overview);
  } catch (err) {
    console.error("[DASHBOARD] Erro em /admin/dashboard-overview:", err);
    return res.status(500).json({
      error: "Erro ao montar dashboard admin",
      detail: err.message
    });
  }
});

// -----------------------------------------
// Helper: Dashboard Gestor - visão geral (PIX real + repasses)
// -----------------------------------------
async function buildGestorDashboardOverview(params) {
  const { gestorId, from, to } = params || {};

  if (!gestorId) {
    throw new Error("gestorId é obrigatório para o dashboard do gestor");
  }

  // Período padrão: mês atual
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, "0");

  const defaultFrom = `${yyyy}-${mm}-01`;
  const defaultTo = new Date(yyyy, hoje.getMonth() + 1, 0).toISOString().slice(0, 10);

  const fromStr =
    typeof from === "string" && from.length >= 10 ? from.slice(0, 10) : defaultFrom;

  const toStr =
    typeof to === "string" && to.length >= 10 ? to.slice(0, 10) : defaultTo;

  // -----------------------------
  // 1) Reservas (para contagens)
  // -----------------------------
  const { data: reservas, error: errRes } = await supabase
    .from("reservas")
    .select(
      `
      id,
      data,
      hora,
      status,
      preco_total,
      origem,
      user_cpf,
      phone,
      quadras:quadras!inner (
        id,
        tipo,
        material,
        modalidade,
        gestor_id
      )
    `
    )
    .gte("data", fromStr)
    .lte("data", toStr)
    .eq("quadras.gestor_id", gestorId);

  if (errRes) {
    console.error("[DASHBOARD GESTOR] Erro ao buscar reservas:", errRes);
    throw errRes;
  }

  const reservasList = reservas || [];

  let totalReservas = 0;
  let reservasPagas = 0;
  let reservasPendentes = 0;
  let reservasCanceladas = 0;

  const porDia = new Map(); // dia -> { criadas, pagas }
  const porQuadraReservas = new Map(); // quadra_id -> { quadra_id, quadra_nome, total_reservas, pagas, pendentes, canceladas }

  for (const r of reservasList) {
    totalReservas += 1;

    const st = String(r.status || "").toLowerCase().trim();
    const dia = typeof r.data === "string" ? r.data.slice(0, 10) : null;

    if (st === "paid") reservasPagas += 1;
    else if (st === "pending") reservasPendentes += 1;
    else if (st === "cancelled" || st === "canceled") reservasCanceladas += 1;

    if (dia) {
      if (!porDia.has(dia)) porDia.set(dia, { criadas: 0, pagas: 0 });
      const infoDia = porDia.get(dia);
      infoDia.criadas += 1;
      if (st === "paid") infoDia.pagas += 1;
    }

    const quadra = r.quadras || null;
    const quadraId = quadra?.id || null;
    if (quadraId) {
      if (!porQuadraReservas.has(quadraId)) {
        porQuadraReservas.set(quadraId, {
          quadra_id: quadraId,
          quadra_nome: buildNomeQuadraDinamico(quadra),
          total_reservas: 0,
          pagas: 0,
          pendentes: 0,
          canceladas: 0
        });
      }
      const row = porQuadraReservas.get(quadraId);
      row.total_reservas += 1;
      if (st === "paid") row.pagas += 1;
      else if (st === "pending") row.pendentes += 1;
      else if (st === "cancelled" || st === "canceled") row.canceladas += 1;
    }
  }

  const labels = buildDateArray(fromStr, toStr);
  const reservasCriadas = [];
  const reservasPagasArray = [];
  for (const d of labels) {
    const info = porDia.get(d) || { criadas: 0, pagas: 0 };
    reservasCriadas.push(info.criadas);
    reservasPagasArray.push(info.pagas);
  }

  const ultimasReservas = reservasList
    .slice()
    .sort((a, b) => {
      const da = String(a.data || "");
      const db = String(b.data || "");
      if (da === db) return String(b.hora || "").localeCompare(String(a.hora || ""));
      return db.localeCompare(da);
    })
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      data: r.data,
      hora: r.hora,
      status: r.status,
      preco_total: Number(r.preco_total || 0),
      origem: r.origem || null,
      quadra_nome: buildNomeQuadraDinamico(r.quadras || null),
      user_cpf: r.user_cpf,
      phone: r.phone
    }));

  // -----------------------------
  // 2) PIX real (pagamentos)
  // - faturamento do dashboard do gestor = SOMENTE pagamentos pagos
  // -----------------------------
  const fromDateTime = `${fromStr}T00:00:00`;
  const toDateTime = `${toStr}T23:59:59`;

  const { data: pagamentos, error: errPag } = await supabase
    .from("pagamentos")
    .select("*")
    .gte("created_at", fromDateTime)
    .lte("created_at", toDateTime);

  if (errPag) {
    console.error("[DASHBOARD GESTOR] Erro ao buscar pagamentos:", errPag);
    throw errPag;
  }

  const pagamentosList = pagamentos || [];

  // Puxa reservas/quadras dos pagamentos para filtrar só do gestor
  const reservaIdsPag = Array.from(
    new Set(
      pagamentosList
        .map((p) => p.reserva_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  let reservasPagList = [];
  if (reservaIdsPag.length > 0) {
    const { data: rr, error: errR2 } = await supabase
      .from("reservas")
      .select("id, quadra_id, data, hora, preco_total, status")
      .in("id", reservaIdsPag);

    if (errR2) throw errR2;
    reservasPagList = rr || [];
  }

  const reservasPagMap = new Map();
  for (const r of reservasPagList) reservasPagMap.set(r.id, r);

  const quadraIdsPag = Array.from(
    new Set(
      reservasPagList
        .map((r) => r.quadra_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  let quadrasPagList = [];
  if (quadraIdsPag.length > 0) {
    const { data: qq, error: errQ2 } = await supabase
      .from("quadras")
      .select("id, tipo, material, modalidade, gestor_id")
      .in("id", quadraIdsPag);

    if (errQ2) throw errQ2;
    quadrasPagList = qq || [];
  }

  const quadrasPagMap = new Map();
  for (const q of quadrasPagList) quadrasPagMap.set(q.id, q);

  // Filtra pagamentos que são do gestor
  const pagamentosDoGestor = pagamentosList.filter((p) => {
    const r = reservasPagMap.get(p.reserva_id);
    if (!r) return false;
    const q = quadrasPagMap.get(r.quadra_id);
    if (!q) return false;
    return String(q.gestor_id) === String(gestorId);
  });

  const pagamentosPagos = (pagamentosDoGestor || []).filter((p) => isPagamentoPago(p.status));
  const pagamentosPendentes = (pagamentosDoGestor || []).filter(
    (p) => !isPagamentoPago(p.status) && !isPagamentoCancelado(p.status)
  );

  let pixRecebidoValor = 0;
  for (const p of pagamentosPagos) pixRecebidoValor += Number(p.valor_total || 0);

  // Top quadras por faturamento (PIX pago)
  const porQuadraFaturamento = new Map();
  for (const p of pagamentosPagos) {
    const r = reservasPagMap.get(p.reserva_id);
    if (!r) continue;
    const q = quadrasPagMap.get(r.quadra_id);
    if (!q) continue;

    const key = q.id;
    if (!porQuadraFaturamento.has(key)) {
      porQuadraFaturamento.set(key, {
        quadra_id: q.id,
        quadra_nome: buildNomeQuadraDinamico(q),
        reservas_pagas: 0,
        faturamento: 0
      });
    }
    const row = porQuadraFaturamento.get(key);
    row.reservas_pagas += 1;
    row.faturamento += Number(p.valor_total || 0);
  }

  const vendasPorQuadra = Array.from(porQuadraFaturamento.values()).sort(
    (a, b) => b.faturamento - a.faturamento
  );

  // -----------------------------
  // 3) Repasses (gestor)
  // -----------------------------
  const { data: repasses, error: errRep } = await supabase
    .from("repasses")
    .select("*")
    .eq("gestor_id", gestorId)
    .order("created_at", { ascending: false });

  if (errRep) {
    console.error("[DASHBOARD GESTOR] Erro ao buscar repasses:", errRep);
    throw errRep;
  }

  const repassesList = repasses || [];

  // Soma repasses do mês (pela competencia YYYY-MM)
  const competenciaMes = fromStr.slice(0, 7); // "YYYY-MM"
  let repassesPendentesValor = 0;
  let repassesPagosValor = 0;

  for (const r of repassesList) {
    const comp = String(r.competencia || "").slice(0, 7);
    if (comp !== competenciaMes) continue;

    const st = String(r.status || "").toLowerCase().trim();
    const liq = Number(r.valor_total_liquido || 0);

    if (st === "pago" || st === "paid") repassesPagosValor += liq;
    else repassesPendentesValor += liq;
  }

  return {
    period: { from: fromStr, to: toStr },
    kpis: {
      total_reservas: totalReservas,
      reservas_pagas: reservasPagas,
      reservas_pendentes: reservasPendentes,
      reservas_canceladas: reservasCanceladas,

      pix_recebidos_qtd: pagamentosPagos.length,
      pix_recebidos_valor: pixRecebidoValor,
      pix_pendentes_qtd: pagamentosPendentes.length,

      repasses_pendentes_valor: repassesPendentesValor,
      repasses_pagos_valor: repassesPagosValor
    },
    utilizacao_canal: {
      labels,
      reservas_criadas: reservasCriadas,
      reservas_pagas: reservasPagasArray
    },
    reservas_por_quadra: Array.from(porQuadraReservas.values()).sort(
      (a, b) => b.total_reservas - a.total_reservas
    ),
    vendas_por_quadra: vendasPorQuadra,
    ultimas_reservas: ultimasReservas
  };
}


// -----------------------------------------
// Rota: Dashboard Gestor - visão geral
// -----------------------------------------
app.get("/gestor/dashboard-overview", autenticarPainel, async (req, res) => {

  try {
    const { from, to } = req.query;
    const gestorId = req.user.id;


    if (!gestorId) {
      return res.status(400).json({
        error: "Parâmetro gestorId é obrigatório em /gestor/dashboard-overview"
      });
    }

    const overview = await buildGestorDashboardOverview({
      gestorId,
      from,
      to
    });

    return res.status(200).json(overview);
  } catch (err) {
    console.error("[DASHBOARD GESTOR] Erro em /gestor/dashboard-overview:", err);
    return res.status(500).json({
      error: "Erro ao montar dashboard do gestor",
      detail: err.message
    });
  }
});


// -----------------------------------------
// Helper: quais campos da QUADRA podem ser editados via painel
// -----------------------------------------
function buildQuadraUpdateBody(body) {
  if (!body || typeof body !== "object") {
    return {};
  }

  // Campos que EXISTEM na tabela quadras após a normalização
  const allowedFields = [
    "tipo",
    "material",
    "modalidade",
    "informacoes",
    "aviso",
    "url_imagem_header",
    "url_imagem_2",
    "empresa_id"
    // gestor_id NÃO entra aqui para o gestor; apenas o admin pode alterar (tratado na rota /admin/quadras/:id)
  ];

  const updates = {};

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const value = body[field];

      // Se vier string, faz trim; se vazio, seta null
      if (typeof value === "string") {
        const trimmed = value.trim();
        updates[field] = trimmed.length > 0 ? trimmed : null;
      } else {
        updates[field] = value;
      }
    }
  }

  return updates;
}

// -----------------------------------------
// GET /gestor/quadras  → lista quadras do gestor
// Query params:
//   - gestorId (obrigatório)
//   - empresaId (opcional, para filtrar por um complexo específico)
//
// Exemplo:
//   GET /gestor/quadras?gestorId=UUID_DO_GESTOR
//   GET /gestor/quadras?gestorId=UUID_DO_GESTOR&empresaId=UUID_DA_EMPRESA
// -----------------------------------------
app.get("/gestor/quadras", autenticarPainel, async (req, res) => {
  try {
    const { empresaId } = req.query;
    const gestorId = req.user.id;

    if (!gestorId) {
      return res.status(400).json({
        error: "Parâmetro gestorId é obrigatório em /gestor/quadras."
      });
    }

    console.log("[GESTOR/QUADRAS][GET] Listando quadras para gestorId =", gestorId, "| empresaId =", empresaId || "todos");

    // Monta a query base
    let query = supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        status,
        aviso,
        informacoes,
        empresa_id,
        gestor_id,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        empresas:empresa_id (
          id,
          nome,
          endereco_resumo
        )
      `
      )
      .eq("gestor_id", gestorId)
      .order("tipo", { ascending: true })
      .order("material", { ascending: true })
      .order("modalidade", { ascending: true });

    // Se veio empresaId, filtra também por ela
    if (empresaId) {
      query = query.eq("empresa_id", empresaId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[GESTOR/QUADRAS][GET] Erro ao buscar quadras:", error);
      return res.status(500).json({
        error: "Erro ao buscar quadras em /gestor/quadras."
      });
    }

    // Normaliza o nome do campo da empresa para ficar mais amigável no frontend
    const quadrasFormatadas =
      data?.map((q) => ({
        id: q.id,
        tipo: q.tipo,
        material: q.material,
        modalidade: q.modalidade,
        status: q.status,
        aviso: q.aviso,
        informacoes: q.informacoes,
        empresa_id: q.empresa_id,
        gestor_id: q.gestor_id,
        url_imagem_header: q.url_imagem_header,
        url_imagem_2: q.url_imagem_2,
        url_imagem_3: q.url_imagem_3,
        empresa: q.empresas
          ? {
              id: q.empresas.id,
              nome: q.empresas.nome,
              endereco_resumo: q.empresas.endereco_resumo
            }
          : null
      })) || [];

    return res.json({
      quadras: quadrasFormatadas
    });
  } catch (err) {
    console.error("[GESTOR/QUADRAS][GET] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro inesperado ao listar quadras em /gestor/quadras."
    });
  }
});
// -----------------------------------------
// PUT /gestor/quadras/:id  → edita quadra (texto + fotos)
// Aceita form-data com:
//   - tipo, material, modalidade, aviso, informacoes, status
//   - foto1, foto2, foto3 (opcionais)
// -----------------------------------------
app.put(
  "/gestor/quadras/:id",
  upload.fields([
    { name: "foto1", maxCount: 1 },
    { name: "foto2", maxCount: 1 },
    { name: "foto3", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        tipo,
        material,
        modalidade,
        aviso,
        informacoes,
        status
      } = req.body;

      console.log("[GESTOR/QUADRAS][PUT] Editando quadra", id);

      // 1) Buscar quadra atual para pegar gestor_id e URLs atuais
      const { data: quadraAtual, error: erroBusca } = await supabase
        .from("quadras")
        .select(
          `
          id,
          gestor_id,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .eq("id", id)
        .single();

      if (erroBusca || !quadraAtual) {
        console.error("[GESTOR/QUADRAS][PUT] Quadra não encontrada:", erroBusca);
        return res.status(404).json({ error: "Quadra não encontrada." });
      }

      // Validação simples
      if (!tipo || !material || !modalidade) {
        return res.status(400).json({
          error: "Campos tipo, material e modalidade são obrigatórios."
        });
      }

      // Começa com os dados de texto
      const dadosAtualizar = {
        tipo,
        material,
        modalidade,
        aviso,
        informacoes,
        status: status || "ativa",
        url_imagem_header: quadraAtual.url_imagem_header,
        url_imagem_2: quadraAtual.url_imagem_2,
        url_imagem_3: quadraAtual.url_imagem_3
      };

      // Função auxiliar para extrair o caminho interno no bucket a partir da URL pública
      function extrairPath(urlPublica) {
        if (!urlPublica) return null;
        const partes = urlPublica.split("/storage/v1/object/public/quadras/");
        return partes[1] || null;
      }

      const bucket = "quadras";

      // 2) Processar cada foto, se vier no form
      const arquivos = req.files || {};

      // FOTO 1 → url_imagem_header
      if (arquivos.foto1 && arquivos.foto1[0]) {
        const file = arquivos.foto1[0];

        // remove a anterior se existir
        const pathAntigo = extrairPath(quadraAtual.url_imagem_header);
        if (pathAntigo) {
          await supabase.storage.from(bucket).remove([pathAntigo]);
        }

        const ext = file.originalname.split(".").pop() || "jpg";
        const pathNovo = `${quadraAtual.gestor_id}/${id}/foto1.${ext}`;

        const { error: erroUpload } = await supabase.storage
          .from(bucket)
          .upload(pathNovo, file.buffer, {
            contentType: file.mimetype,
            upsert: true
          });

        if (erroUpload) {
          console.error(
            "[GESTOR/QUADRAS][PUT] Erro upload foto1:",
            erroUpload
          );
          return res.status(500).json({
            error: "Erro ao enviar foto1 da quadra."
          });
        }

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${pathNovo}`;
        dadosAtualizar.url_imagem_header = publicUrl;
      }

      // FOTO 2 → url_imagem_2
      if (arquivos.foto2 && arquivos.foto2[0]) {
        const file = arquivos.foto2[0];

        const pathAntigo = extrairPath(quadraAtual.url_imagem_2);
        if (pathAntigo) {
          await supabase.storage.from(bucket).remove([pathAntigo]);
        }

        const ext = file.originalname.split(".").pop() || "jpg";
        const pathNovo = `${quadraAtual.gestor_id}/${id}/foto2.${ext}`;

        const { error: erroUpload } = await supabase.storage
          .from(bucket)
          .upload(pathNovo, file.buffer, {
            contentType: file.mimetype,
            upsert: true
          });

        if (erroUpload) {
          console.error(
            "[GESTOR/QUADRAS][PUT] Erro upload foto2:",
            erroUpload
          );
          return res.status(500).json({
            error: "Erro ao enviar foto2 da quadra."
          });
        }

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${pathNovo}`;
        dadosAtualizar.url_imagem_2 = publicUrl;
      }

      // FOTO 3 → url_imagem_3
      if (arquivos.foto3 && arquivos.foto3[0]) {
        const file = arquivos.foto3[0];

        const pathAntigo = extrairPath(quadraAtual.url_imagem_3);
        if (pathAntigo) {
          await supabase.storage.from(bucket).remove([pathAntigo]);
        }

        const ext = file.originalname.split(".").pop() || "jpg";
        const pathNovo = `${quadraAtual.gestor_id}/${id}/foto3.${ext}`;

        const { error: erroUpload } = await supabase.storage
          .from(bucket)
          .upload(pathNovo, file.buffer, {
            contentType: file.mimetype,
            upsert: true
          });

        if (erroUpload) {
          console.error(
            "[GESTOR/QUADRAS][PUT] Erro upload foto3:",
            erroUpload
          );
          return res.status(500).json({
            error: "Erro ao enviar foto3 da quadra."
          });
        }

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${pathNovo}`;
        dadosAtualizar.url_imagem_3 = publicUrl;
      }

      // 3) Atualizar no banco
      const { data, error } = await supabase
        .from("quadras")
        .update(dadosAtualizar)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error(
          "[GESTOR/QUADRAS][PUT] Erro ao atualizar quadra:",
          error
        );
        return res.status(500).json({
          error: "Erro ao atualizar quadra em /gestor/quadras/:id."
        });
      }

      return res.json({ quadra: data });
    } catch (err) {
      console.error("[GESTOR/QUADRAS][PUT] Erro inesperado:", err);
      return res.status(500).json({
        error: "Erro inesperado ao atualizar quadra em /gestor/quadras/:id."
      });
    }
  }
);
// -----------------------------------------
// PUT /gestor/quadras/:id/fotos
// Atualiza somente as fotos da quadra (substitui as existentes)
// -----------------------------------------
app.put(
  "/gestor/quadras/:id/fotos",
  authPainel,
  permitirTipos("GESTOR"),
  upload.fields([
    { name: "foto1", maxCount: 1 },
    { name: "foto2", maxCount: 1 },
    { name: "foto3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id } = req.params;

      // 1) Busca quadra do próprio gestor
      const { data: quadraAtual, error: erroQuadra } = await supabase
        .from("quadras")
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .single();

      if (erroQuadra || !quadraAtual) {
        console.error(
          "[GESTOR/QUADRAS][PUT-FOTOS] Quadra não encontrada para este gestor:",
          erroQuadra
        );
        return res
          .status(404)
          .json({ error: "Quadra não encontrada para este gestor." });
      }

      // 2) Helpers para lidar com Storage
      function extrairPath(urlPublica) {
        if (!urlPublica) return null;
        const partes = urlPublica.split(
          "/storage/v1/object/public/quadras/"
        );
        return partes[1] || null;
      }

      const arquivos = req.files || {};
      const bucketName = "quadras";
      const bucket = supabase.storage.from(bucketName);

      const updates = {};

      // FOTO 1 → url_imagem_header
      if (arquivos.foto1 && arquivos.foto1[0]) {
        const file = arquivos.foto1[0];

        const antigo = extrairPath(quadraAtual.url_imagem_header);
        if (antigo) {
          await bucket.remove([antigo]);
        }

        const ext = (file.originalname.split(".").pop() || "jpg").toLowerCase();
        const pathNovo = `${gestorId}/${id}/foto1.${ext}`;

        const { error: uploadError } = await bucket.upload(
          pathNovo,
          file.buffer,
          {
            contentType: file.mimetype,
            upsert: true,
          }
        );

        if (uploadError) {
          console.error(
            "[GESTOR/QUADRAS][PUT-FOTOS] Erro upload foto1:",
            uploadError
          );
          return res
            .status(500)
            .json({ error: "Erro ao enviar foto1 da quadra." });
        }

        const { data: publicData } = bucket.getPublicUrl(pathNovo);
        updates.url_imagem_header = publicData?.publicUrl || null;
      }

      // FOTO 2 → url_imagem_2
      if (arquivos.foto2 && arquivos.foto2[0]) {
        const file = arquivos.foto2[0];

        const antigo = extrairPath(quadraAtual.url_imagem_2);
        if (antigo) {
          await bucket.remove([antigo]);
        }

        const ext = (file.originalname.split(".").pop() || "jpg").toLowerCase();
        const pathNovo = `${gestorId}/${id}/foto2.${ext}`;

        const { error: uploadError } = await bucket.upload(
          pathNovo,
          file.buffer,
          {
            contentType: file.mimetype,
            upsert: true,
          }
        );

        if (uploadError) {
          console.error(
            "[GESTOR/QUADRAS][PUT-FOTOS] Erro upload foto2:",
            uploadError
          );
          return res
            .status(500)
            .json({ error: "Erro ao enviar foto2 da quadra." });
        }

        const { data: publicData } = bucket.getPublicUrl(pathNovo);
        updates.url_imagem_2 = publicData?.publicUrl || null;
      }

      // FOTO 3 → url_imagem_3
      if (arquivos.foto3 && arquivos.foto3[0]) {
        const file = arquivos.foto3[0];

        const antigo = extrairPath(quadraAtual.url_imagem_3);
        if (antigo) {
          await bucket.remove([antigo]);
        }

        const ext = (file.originalname.split(".").pop() || "jpg").toLowerCase();
        const pathNovo = `${gestorId}/${id}/foto3.${ext}`;

        const { error: uploadError } = await bucket.upload(
          pathNovo,
          file.buffer,
          {
            contentType: file.mimetype,
            upsert: true,
          }
        );

        if (uploadError) {
          console.error(
            "[GESTOR/QUADRAS][PUT-FOTOS] Erro upload foto3:",
            uploadError
          );
          return res
            .status(500)
            .json({ error: "Erro ao enviar foto3 da quadra." });
        }

        const { data: publicData } = bucket.getPublicUrl(pathNovo);
        updates.url_imagem_3 = publicData?.publicUrl || null;
      }

      if (Object.keys(updates).length === 0) {
        // Nenhuma foto enviada → só devolve o registro atual
        return res.json(quadraAtual);
      }

      // 3) Atualiza quadra com novas URLs
      const { data: quadraAtualizada, error: erroUpdate } = await supabase
        .from("quadras")
        .update(updates)
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .select(
          `
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `
        )
        .single();

      if (erroUpdate || !quadraAtualizada) {
        console.error(
          "[GESTOR/QUADRAS][PUT-FOTOS] Erro ao atualizar quadra:",
          erroUpdate
        );
        return res
          .status(500)
          .json({ error: "Erro ao salvar fotos da quadra." });
      }

      console.log(
        "[GESTOR/QUADRAS][PUT-FOTOS] Fotos atualizadas para quadra:",
        quadraAtualizada.id
      );
      return res.json(quadraAtualizada);
    } catch (err) {
      console.error("[GESTOR/QUADRAS][PUT-FOTOS] Erro inesperado:", err);
      return res
        .status(500)
        .json({ error: "Erro interno ao atualizar fotos da quadra." });
    }
  }
);

// [SOURCE: index.js] - Substitua a rota DELETE existente por esta:

// DELETE /gestor/quadras/:id/foto/:slot
// Zera SOMENTE a coluna correspondente no banco
app.delete(
  "/gestor/quadras/:id/foto/:slot",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    try {
      const gestorId = req.usuarioPainel.id;
      const { id, slot } = req.params;

      // 1. Mapeamento explícito para evitar erros de lógica
      const mapaColunas = {
        "1": "url_imagem_header",
        "2": "url_imagem_2",
        "3": "url_imagem_3"
      };

      const colunaAlvo = mapaColunas[slot];

      if (!colunaAlvo) {
        return res.status(400).json({ 
          error: "Slot inválido. Use 1, 2 ou 3." 
        });
      }

      console.log(`[DELETE FOTO] Gestor ${gestorId} removendo foto ${slot} (${colunaAlvo}) da quadra ${id}`);

      // 2. Monta o objeto de atualização APENAS com a coluna alvo
      const updates = {};
      updates[colunaAlvo] = null;

      // Log para conferir o que está indo pro banco
      console.log("[DELETE FOTO] Payload enviado ao Supabase:", JSON.stringify(updates));

      // 3. Executa o update
      const { data: quadraAtualizada, error: erroUpdate } = await supabase
        .from("quadras")
        .update(updates)
        .eq("id", id)
        .eq("gestor_id", gestorId)
        .select(`
          id,
          empresa_id,
          gestor_id,
          tipo,
          material,
          modalidade,
          informacoes,
          aviso,
          status,
          url_imagem_header,
          url_imagem_2,
          url_imagem_3
        `)
        .single();

      if (erroUpdate) {
        console.error("[GESTOR/QUADRAS][DEL-FOTO] Erro ao atualizar quadra:", erroUpdate);
        return res.status(500).json({ error: "Erro ao remover foto da quadra." });
      }

      if (!quadraAtualizada) {
        return res.status(404).json({ error: "Quadra não encontrada ou não pertence a este gestor." });
      }

      console.log("[GESTOR/QUADRAS][DEL-FOTO] Sucesso. Estado atual:", {
        foto1: !!quadraAtualizada.url_imagem_header,
        foto2: !!quadraAtualizada.url_imagem_2,
        foto3: !!quadraAtualizada.url_imagem_3
      });

      return res.json(quadraAtualizada);

    } catch (err) {
      console.error("[GESTOR/QUADRAS][DEL-FOTO] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro interno ao remover foto da quadra." });
    }
  }
);
// -----------------------------------------
// -----------------------------------------
// GET /gestor/reservas  → lista reservas do gestor
// Query:
//   - gestorId: UUID do gestor (obrigatório)
//   - quadraId: UUID da quadra (opcional, para filtrar só uma quadra)
// -----------------------------------------
app.get("/gestor/reservas", autenticarPainel, async (req, res) => {
  try {
    const { quadraId } = req.query;
    const gestorId = req.user.id;

    // 1) Validação básica
    if (!gestorId) {
      return res.status(400).json({
        error: "Parâmetro gestorId é obrigatório em /gestor/reservas"
      });
    }

    // 2) Buscar todas as quadras deste gestor
    const { data: quadras, error: quadrasError } = await supabase
      .from("quadras")
      .select(`
        id,
        informacoes,
        created_at,
        url_imagem_header,
        aviso,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id,
        tipo,
        material,
        modalidade
      `)
      .eq("gestor_id", gestorId)
      .order("tipo", { ascending: true })
      .order("material", { ascending: true })
      .order("modalidade", { ascending: true });

    if (quadrasError) {
      console.error("[GESTOR/RESERVAS] Erro ao buscar quadras:", quadrasError);
      return res.status(500).json({
        error: "Erro ao buscar quadras do gestor em /gestor/reservas"
      });
    }

    // Se o gestor não tiver nenhuma quadra, já devolve vazio
    if (!quadras || quadras.length === 0) {
      return res.json({
        gestorId,
        quadraId: quadraId || null,
        quadras: [],
        reservas: []
      });
    }

    // 3) Se veio quadraId, filtra as quadras só para essa
    let quadrasFiltradas = quadras;
    if (quadraId) {
      quadrasFiltradas = quadras.filter((q) => q.id === quadraId);

      // Se o gestor tentou filtrar por uma quadra que não é dele, devolve vazio
      if (quadrasFiltradas.length === 0) {
        return res.json({
          gestorId,
          quadraId,
          quadras, // manda todas pra montar o select no front
          reservas: []
        });
      }
    }

    const quadraIds = quadrasFiltradas.map((q) => q.id);

    // 4) Buscar reservas dessas quadras (tabela public.reservas)
    const { data: reservas, error: reservasError } = await supabase
      .from("reservas")
      .select(`
        id,
        quadra_id,
        user_cpf,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        created_at,
        phone,
        id_transacao_pix,
        usuario_id
      `)
      .in("quadra_id", quadraIds)
      .order("data", { ascending: true })
      .order("hora", { ascending: true });

    if (reservasError) {
      console.error(
        "[GESTOR/RESERVAS] Erro ao buscar reservas (detalhe):",
        reservasError
      );
      return res.status(500).json({
        error: "Erro ao buscar reservas em /gestor/reservas"
      });
    }

    // 5) Enriquecer reservas com informações da quadra associada
    const reservasComQuadra = (reservas || []).map((reserva) => {
      const quadra = quadras.find((q) => q.id === reserva.quadra_id) || null;
      return {
        ...reserva,
        quadra
      };
    });

    // 6) Resposta final
    return res.json({
      gestorId,
      quadraId: quadraId || null,
      quadras,          // todas as quadras do gestor (pra montar select no painel)
      reservas: reservasComQuadra
    });
  } catch (err) {
    console.error("[GESTOR/RESERVAS] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno em /gestor/reservas"
    });
  }
});
// -----------------------------------------
// GET /gestor/reservas/:id  → detalhe de UMA reserva do gestor
// Usado quando o Gestor clica num horário vermelho
// Retorna:
//   - reserva  (dados da tabela reservas)
//   - quadra   (dados básicos da quadra, para exibir nome dinâmico etc.)
// -----------------------------------------
app.get("/gestor/reservas/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;
    const reservaId = req.params.id;

    if (!gestorId) {
      return res.status(400).json({
        error: "Token inválido em /gestor/reservas/:id",
      });
    }

    if (!reservaId) {
      return res.status(400).json({
        error: "Parâmetro :id é obrigatório em /gestor/reservas/:id",
      });
    }

    // 1) Busca a reserva
    const { data: reserva, error: reservaError } = await supabase
      .from("reservas")
.select(
  `
  id,
  quadra_id,
  user_cpf,
  data,
  hora,
  status,
  preco_total,
  pago_via_pix,
  origem,
  created_at,
  phone,
  id_transacao_pix,
  usuario_id
`
)

      .eq("id", reservaId)
      .single();

    if (reservaError) {
      console.error(
        "[GESTOR/RESERVAS][GET/:id] Erro ao buscar reserva:",
        reservaError
      );
      return res.status(500).json({
        error: "Erro ao buscar reserva em /gestor/reservas/:id",
      });
    }

    if (!reserva) {
      return res.status(404).json({
        error: "Reserva não encontrada.",
      });
    }

    // 2) Busca a quadra associada
    const { data: quadra, error: quadraError } = await supabase
      .from("quadras")
      .select(
        `
        id,
        empresa_id,
        gestor_id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        status
      `
      )
      .eq("id", reserva.quadra_id)
      .single();

    if (quadraError) {
      console.error(
        "[GESTOR/RESERVAS][GET/:id] Erro ao buscar quadra da reserva:",
        quadraError
      );
      return res.status(500).json({
        error: "Erro ao buscar quadra associada à reserva.",
      });
    }

    if (!quadra) {
      return res.status(404).json({
        error: "Quadra associada à reserva não encontrada.",
      });
    }

    // 3) Garante que a quadra dessa reserva pertence ao gestor logado
    if (quadra.gestor_id !== gestorId) {
      console.warn(
        "[GESTOR/RESERVAS][GET/:id] Reserva não pertence a este gestor:",
        {
          gestorId,
          quadraGestorId: quadra.gestor_id,
        }
      );
      return res.status(403).json({
        error: "Esta reserva não pertence a nenhuma quadra deste gestor.",
      });
    }

    // 4) Monta resposta (já pronta para preencher o formulário de edição)
    const resposta = {
      reserva,
      quadra: {
        ...quadra,
        nome_dinamico: buildNomeQuadraDinamico
          ? buildNomeQuadraDinamico(quadra)
          : undefined,
      },
    };

    return res.json(resposta);
  } catch (err) {
    console.error("[GESTOR/RESERVAS][GET/:id] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno em /gestor/reservas/:id",
    });
  }
});

// -----------------------------------------
// GET /gestor/reservas/grade → grade tipo "cinema" de uma quadra
// Query:
//   - quadraId  (obrigatório)
//   - dataInicio (opcional, AAAA-MM-DD ou DD/MM/AAAA; default: hoje)
//   - dataFim    (opcional, AAAA-MM-DD ou DD/MM/AAAA; default: dataInicio + 6 dias)
//   - filtro     (opcional: "disponivel", "reservada", "bloqueado", "todas"; default: "todas")
// Retorno: slots por dia/hora com status: DISPONIVEL | RESERVADO | BLOQUEADO
// -----------------------------------------
app.get("/gestor/reservas/grade", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;
    const { quadraId, dataInicio, dataFim, filtro } = req.query || {};

    if (!gestorId) {
      return res.status(400).json({
        error: "Token inválido ou sem id de usuário em /gestor/reservas/grade",
      });
    }

    if (!quadraId) {
      return res.status(400).json({
        error: "Parâmetro quadraId é obrigatório em /gestor/reservas/grade",
      });
    }

    // 1) Garante que a quadra pertence ao Gestor (reaproveita helper já existente)
    try {
      await validarQuadraDoGestor(quadraId, gestorId);
    } catch (e) {
      console.error("[GESTOR/RESERVAS/GRADE] Quadra inválida:", e);
      return res.status(403).json({
        error: "Quadra não pertence a este gestor ou não existe.",
      });
    }

    // 2) Trata datas (usa o mesmo parser do fluxo de agendamento)
    const hoje = new Date();
    let dtInicio =
      dataInicio && dataInicio.trim()
        ? parseDataAgendamentoBr(dataInicio)
        : hoje;
    if (!dtInicio || Number.isNaN(dtInicio.getTime())) {
      return res.status(400).json({
        error:
          "dataInicio inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /gestor/reservas/grade.",
      });
    }

    let dtFim;
    if (dataFim && dataFim.trim()) {
      dtFim = parseDataAgendamentoBr(dataFim);
      if (!dtFim || Number.isNaN(dtFim.getTime())) {
        return res.status(400).json({
          error:
            "dataFim inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /gestor/reservas/grade.",
        });
      }
    } else {
      // Default: 7 dias de janela (hoje + 6)
      dtFim = new Date(dtInicio);
      dtFim.setDate(dtFim.getDate() + 6);
    }

    // Garante dtInicio <= dtFim
    if (dtFim.getTime() < dtInicio.getTime()) {
      const tmp = dtInicio;
      dtInicio = dtFim;
      dtFim = tmp;
    }

    // Limita range a 31 dias para não sobrecarregar
    const MS_DIA = 24 * 60 * 60 * 1000;
    const diffDias = Math.round((dtFim - dtInicio) / MS_DIA);
    if (diffDias > 31) {
      return res.status(400).json({
        error:
          "Intervalo máximo permitido em /gestor/reservas/grade é de 31 dias.",
      });
    }

    const fromISO = formatDateISO(dtInicio);
    const toISO = formatDateISO(dtFim);

    // Normaliza filtro
    const filtroNorm = (filtro || "todas").toLowerCase();
    const filtroValido = ["todas", "disponivel", "reservada", "bloqueado"];
    const filtroFinal = filtroValido.includes(filtroNorm)
      ? filtroNorm
      : "todas";

    // 3) Busca regras de horários da quadra (por dia da semana)
    const { data: regras, error: regrasError } = await supabase
      .from("regras_horarios")
      .select("id, dia_da_semana, hora_inicio, hora_fim, valor")
      .eq("id_quadra", quadraId)
      .order("dia_da_semana", { ascending: true })
      .order("hora_inicio", { ascending: true });

    if (regrasError) {
      console.error(
        "[GESTOR/RESERVAS/GRADE] Erro ao buscar regras_horarios:",
        regrasError
      );
      return res.status(500).json({
        error: "Erro ao buscar regras de horários em /gestor/reservas/grade",
      });
    }

    // Se não há regras, não há nada para mostrar
    if (!regras || regras.length === 0) {
      return res.status(200).json({
        quadra_id: quadraId,
        data_inicio: fromISO,
        data_fim: toISO,
        filtro: filtroFinal,
        slots: [],
      });
    }

    // 4) Busca reservas da quadra no intervalo
    const { data: reservas, error: reservasError } = await supabase
      .from("reservas")
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        user_cpf,
        phone,
        id_transacao_pix,
        usuario_id,
        created_at
      `
      )
      .eq("quadra_id", quadraId)
      .gte("data", fromISO)
      .lte("data", toISO)
      .order("data", { ascending: true })
      .order("hora", { ascending: true });

    if (reservasError) {
      console.error(
        "[GESTOR/RESERVAS/GRADE] Erro ao buscar reservas:",
        reservasError
      );
      return res.status(500).json({
        error: "Erro ao buscar reservas em /gestor/reservas/grade",
      });
    }

    // 5) Busca bloqueios da quadra no intervalo
    const { data: bloqueios, error: bloqueiosError } = await supabase
      .from("bloqueios_quadra")
      .select(
        `
        id,
        quadra_id,
        data,
        hora_inicio,
        hora_fim,
        motivo,
        created_at
      `
      )
      .eq("quadra_id", quadraId)
      .gte("data", fromISO)
      .lte("data", toISO)
      .order("data", { ascending: true })
      .order("hora_inicio", { ascending: true });

    if (bloqueiosError) {
      console.error(
        "[GESTOR/RESERVAS/GRADE] Erro ao buscar bloqueios:",
        bloqueiosError
      );
      return res.status(500).json({
        error: "Erro ao buscar bloqueios em /gestor/reservas/grade",
      });
    }

    // 6) Indexa reservas por (data|hora) só se estiverem ocupando o slot
    const reservasPorChave = new Map();
    for (const r of reservas || []) {
      // Considera somente pending/paid como ocupando o horário.
      if (!r || !["pending", "paid"].includes(r.status)) continue;
      const chave = `${r.data}|${r.hora}`;
      reservasPorChave.set(chave, r);
    }

    // 7) Indexa bloqueios por data
    const bloqueiosPorData = new Map();
    for (const b of bloqueios || []) {
      if (!b || !b.data) continue;
      const lista = bloqueiosPorData.get(b.data) || [];
      lista.push(b);
      bloqueiosPorData.set(b.data, lista);
    }

    // Helper para HH:MM -> minutos
    function horaParaMinutos(horaStr) {
      if (!horaStr || typeof horaStr !== "string") return null;
      const [hStr, mStr] = horaStr.split(":");
      const h = Number(hStr);
      const m = Number(mStr ?? "0");
      if (
        Number.isNaN(h) ||
        Number.isNaN(m) ||
        h < 0 ||
        h > 23 ||
        m < 0 ||
        m > 59
      ) {
        return null;
      }
      return h * 60 + m;
    }

    // Helper: verifica se o slot [horaSlot, horaSlot + 60) está dentro de algum bloqueio do dia
    function encontrarBloqueioParaSlot(dataISO, horaSlot) {
      const lista = bloqueiosPorData.get(dataISO);
      if (!lista || lista.length === 0) return null;

      const slotInicioMin = horaParaMinutos(horaSlot);
      if (slotInicioMin === null) return null;
      const slotFimMin = slotInicioMin + 60;

      for (const b of lista) {
        const iniB = horaParaMinutos(b.hora_inicio);
        const fimB = horaParaMinutos(b.hora_fim);
        if (iniB === null || fimB === null) continue;

        // Interseção simples: se o intervalo do slot tem sobreposição com o bloqueio
        const sobrepoe = !(slotFimMin <= iniB || slotInicioMin >= fimB);
        if (sobrepoe) {
          return b;
        }
      }
      return null;
    }

    // 8) Monta a grade por dia + regras (cada regra já é 1 slot de 1h)
    const slots = [];
    const regrasPorDiaSemana = new Map();
    for (const r of regras) {
      const dia = r.dia_da_semana;
      const lista = regrasPorDiaSemana.get(dia) || [];
      lista.push(r);
      regrasPorDiaSemana.set(dia, lista);
    }

    const dtIter = new Date(dtInicio);
    while (dtIter.getTime() <= dtFim.getTime()) {
      const dataISO = formatDateISO(dtIter);
      const diaSemana = dtIter.getDay(); // 0 = Domingo ... 6 = Sábado

      const regrasDia = regrasPorDiaSemana.get(diaSemana) || [];
      for (const regra of regrasDia) {
        const hora = regra.hora_inicio;
        const chave = `${dataISO}|${hora}`;
        const reserva = reservasPorChave.get(chave) || null;
        const bloqueio = encontrarBloqueioParaSlot(dataISO, hora);

        let statusSlot = "DISPONIVEL";
        if (bloqueio) {
          statusSlot = "BLOQUEADO"; // cinza
        }
        if (reserva) {
          statusSlot = "RESERVADO"; // vermelho tem prioridade visual
        }

        // Aplica filtro (se não for "todas")
        if (filtroFinal === "disponivel" && statusSlot !== "DISPONIVEL") {
          continue;
        }
        if (filtroFinal === "reservada" && statusSlot !== "RESERVADO") {
          continue;
        }
        if (filtroFinal === "bloqueado" && statusSlot !== "BLOQUEADO") {
          continue;
        }

        slots.push({
          data: dataISO,
          hora,
          status: statusSlot, // DISPONIVEL | RESERVADO | BLOQUEADO
          preco_hora: regra.valor,
          reserva,
          bloqueio,
        });
      }

      dtIter.setDate(dtIter.getDate() + 1);
    }

    return res.status(200).json({
      quadra_id: quadraId,
      data_inicio: fromISO,
      data_fim: toISO,
      filtro: filtroFinal,
      slots,
    });
  } catch (err) {
    console.error("[GESTOR/RESERVAS/GRADE] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno em /gestor/reservas/grade",
    });
  }
});
// -----------------------------------------
// ADMIN - SLOTS DAS RESERVAS (VISUALIZAÇÃO ESTILO CINEMA)
// -----------------------------------------
// GET /admin/reservas/grade
// Query params:
//   - quadraId (obrigatório)
//   - dataInicio (opcional: AAAA-MM-DD ou DD/MM/AAAA; default: hoje)
//   - dataFim    (opcional: AAAA-MM-DD ou DD/MM/AAAA; default: dataInicio + 6 dias)
//   - filtro     (opcional: "disponivel" | "reservada" | "bloqueado" | "todas"; default: "todas")
// Retorno: slots por dia/hora com status: DISPONIVEL | RESERVADO | BLOQUEADO
// -----------------------------------------
app.get(
  "/admin/reservas/grade",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
    try {
      const { quadraId, dataInicio, dataFim, filtro } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /admin/reservas/grade",
        });
      }

      // 1) Trata datas (reaproveita o mesmo parser do sistema)
      const hoje = new Date();
      let dtInicio =
        dataInicio && String(dataInicio).trim()
          ? parseDataAgendamentoBr(String(dataInicio))
          : hoje;

      if (!dtInicio || Number.isNaN(dtInicio.getTime())) {
        return res.status(400).json({
          error:
            "dataInicio inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /admin/reservas/grade.",
        });
      }

      let dtFim;
      if (dataFim && String(dataFim).trim()) {
        dtFim = parseDataAgendamentoBr(String(dataFim));
        if (!dtFim || Number.isNaN(dtFim.getTime())) {
          return res.status(400).json({
            error:
              "dataFim inválida. Use AAAA-MM-DD ou DD/MM/AAAA em /admin/reservas/grade.",
          });
        }
      } else {
        dtFim = new Date(dtInicio);
        dtFim.setDate(dtFim.getDate() + 6);
      }

      // garante dtInicio <= dtFim
      if (dtFim.getTime() < dtInicio.getTime()) {
        const tmp = dtInicio;
        dtInicio = dtFim;
        dtFim = tmp;
      }

      // limita range (31 dias)
      const MS_DIA = 24 * 60 * 60 * 1000;
      const diffDias = Math.round((dtFim - dtInicio) / MS_DIA);
      if (diffDias > 31) {
        return res.status(400).json({
          error:
            "Intervalo máximo permitido em /admin/reservas/grade é de 31 dias.",
        });
      }

      const dtInicioISO = formatDateISO(dtInicio); // helper já existe no seu index
      const dtFimISO = formatDateISO(dtFim);

      // 2) Busca reservas do período (paid/pending bloqueiam, canceled não bloqueia)
const { data: reservas, error: errR } = await supabase
  .from("reservas")
  .select(
    `
    id,
    quadra_id,
    data,
    hora,
    status,
    origem,
    user_cpf,
    phone,
    preco_total
  `
  )
  .eq("quadra_id", quadraId)
  .gte("data", dtInicioISO)
  .lte("data", dtFimISO);



      if (errR) {
        console.error("[ADMIN/RESERVAS/GRADE] Erro ao buscar reservas:", errR);
        return res.status(500).json({
          error: "Erro ao buscar reservas em /admin/reservas/grade",
          detail: errR.message,
        });
      }

      // 3) Busca bloqueios do período
      const { data: bloqueios, error: errB } = await supabase
        .from("bloqueios_quadra")
        .select("id, quadra_id, data, hora_inicio, hora_fim")
        .eq("quadra_id", quadraId)
        .gte("data", dtInicioISO)
        .lte("data", dtFimISO);

      if (errB) {
        console.error("[ADMIN/RESERVAS/GRADE] Erro ao buscar bloqueios:", errB);
        return res.status(500).json({
          error: "Erro ao buscar bloqueios em /admin/reservas/grade",
          detail: errB.message,
        });
      }

      // 4) Busca regras de horários/preços (agenda) — schema REAL:
// regras_horarios: id_quadra, dia_da_semana, hora_inicio, hora_fim, valor
const { data: regrasRaw, error: errA } = await supabase
  .from("regras_horarios")
  .select("id, id_quadra, dia_da_semana, hora_inicio, hora_fim, valor")
  .eq("id_quadra", quadraId);

if (errA) {
  console.error("[ADMIN/RESERVAS/GRADE] Erro ao buscar agenda:", errA);
  return res.status(500).json({
    error: "Erro ao buscar agenda em /admin/reservas/grade",
    detail: errA.message,
  });
}

// Normaliza para o resto do código continuar igual (sem refatorar tudo)
const regras = (regrasRaw || []).map((r) => ({
  ...r,
  quadra_id: r.id_quadra,                 // alias
  dia_semana: r.dia_da_semana,            // alias
  preco_hora: r.valor,                    // alias
}));



      // 5) Monta mapas rápidos
      const mapReservas = new Map();
      (reservas || []).forEach((r) => {
        // chave = dataISO + "|" + hora
        const dataISO = String(r.data || "").slice(0, 10);
        const hora = String(r.hora || "");
        if (!dataISO || !hora) return;

        // paid/pending bloqueiam; canceled não
        const st = String(r.status || "").toLowerCase();
        if (st === "canceled") return;

        mapReservas.set(`${dataISO}|${hora}`, r);
      });

      const bloqueadoNoHorario = (dataISO, horaStr) => {
        const horaMin = String(horaStr || "").slice(0, 5);
        for (const b of bloqueios || []) {
          const d = String(b.data || "").slice(0, 10);
          if (d !== dataISO) continue;

          const hi = String(b.hora_inicio || "").slice(0, 5);
          const hf = String(b.hora_fim || "").slice(0, 5);

          // intervalo [hi, hf) — mesmo padrão do restante do sistema
          if (horaMin >= hi && horaMin < hf) return true;
        }
        return false;
      };

      const diaSemanaIndex = (dateObj) => {
        // JS: 0=Dom .. 6=Sáb  | seu banco normalmente usa 0..6 também
        return dateObj.getDay();
      };

      const rangeDias = [];
      for (let d = new Date(dtInicio); d <= dtFim; d = new Date(d.getTime() + MS_DIA)) {
        rangeDias.push(new Date(d));
      }

      // 6) Gera grade: para cada dia, slots pelas regras
      const filtroNorm = String(filtro || "todas").toLowerCase();

      const grade = rangeDias.map((dia) => {
        const dataISO = formatDateISO(dia);
        const dow = diaSemanaIndex(dia);

        const regrasDia = (regras || []).filter(
          (r) => Number(r.dia_semana) === Number(dow)
        );

        const slots = [];

        // para cada regra, cria slots de 1h em 1h
        for (const rg of regrasDia) {
          const hi = String(rg.hora_inicio || "").slice(0, 5);
          const hf = String(rg.hora_fim || "").slice(0, 5);
          if (!hi || !hf) continue;

          const [h1, m1] = hi.split(":").map(Number);
          const [h2, m2] = hf.split(":").map(Number);

          // converte para minutos
          let ini = h1 * 60 + (m1 || 0);
          const fim = h2 * 60 + (m2 || 0);

          while (ini < fim) {
            const hIni = String(Math.floor(ini / 60)).padStart(2, "0");
            const mIni = String(ini % 60).padStart(2, "0");
            const horaSlot = `${hIni}:${mIni}`;

            const reserva = mapReservas.get(`${dataISO}|${horaSlot}`) || null;
            const bloqueado = bloqueadoNoHorario(dataISO, horaSlot);

            let statusSlot = "DISPONIVEL";
            if (bloqueado) statusSlot = "BLOQUEADO";
            else if (reserva) statusSlot = "RESERVADO";

            const slotObj = {
              data: dataISO,
              hora: horaSlot,
              preco_hora: rg.preco_hora ?? 0,
              status: statusSlot,
              reserva: reserva
                ? {
                    id: reserva.id,
                    status: reserva.status,
                    origem: reserva.origem,
                    cpf: reserva.user_cpf,
                    phone: reserva.phone,
                    preco_total: reserva.preco_total,
                  }
                : null,
            };

            // aplica filtro
            if (filtroNorm === "todas") slots.push(slotObj);
            else if (filtroNorm === "disponivel" && statusSlot === "DISPONIVEL")
              slots.push(slotObj);
            else if (filtroNorm === "reservada" && statusSlot === "RESERVADO")
              slots.push(slotObj);
            else if (filtroNorm === "bloqueado" && statusSlot === "BLOQUEADO")
              slots.push(slotObj);

            ini += 60; // 1h
          }
        }

        return { data: dataISO, dia_semana: dow, slots };
      });

      return res.status(200).json({ grade });
    } catch (err) {
      console.error("[ADMIN/RESERVAS/GRADE] Erro inesperado:", err);
      return res.status(500).json({
        error: "Erro inesperado em /admin/reservas/grade",
        detail: err.message,
      });
    }
  }
);

// -----------------------------------------
// CRUD de Reservas via Painel do Gestor
// -----------------------------------------

// Helper interno para validar hora HH:MM
function validarHoraHHMM(hora) {
  if (!hora || typeof hora !== "string") return null;
  const m = hora.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (
    Number.isNaN(h) ||
    Number.isNaN(min) ||
    h < 0 ||
    h > 23 ||
    min < 0 ||
    min > 59
  ) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// -----------------------------------------
// POST /gestor/reservas → criar reserva manual (painel Gestor)
// Body esperado:
// {
//   "quadraId": "uuid da quadra",
//   "data": "2025-12-24",   // YYYY-MM-DD
//   "hora": "18:00",        // HH:MM
//   "nome": "Fulano da Silva", // (por enquanto só log, não persiste nome)
//   "cpf": "12345678901",
//   "phone": "84999999999",
//   "valor": 120.5          // valor recebido pelo gestor
// }
// -----------------------------------------
app.post("/gestor/reservas", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;
    const { quadraId, data, hora, nome, cpf, phone, valor } = req.body || {};

    if (!gestorId) {
      return res
        .status(401)
        .json({ error: "Usuário gestor não identificado." });
    }

    if (!quadraId || !data || !hora || !cpf) {
      return res.status(400).json({
        error: "Campos obrigatórios: quadraId, data, hora e cpf."
      });
    }

    // 1) Garantir que a quadra pertence a este gestor
    const { data: quadra, error: erroQuadra } = await supabase
      .from("quadras")
      .select("id, gestor_id")
      .eq("id", quadraId)
      .single();

    if (erroQuadra) {
      console.error(
        "[GESTOR/RESERVAS][CREATE] Erro ao buscar quadra:",
        erroQuadra
      );
      return res.status(500).json({
        error: "Erro ao validar quadra em /gestor/reservas (create)."
      });
    }

    if (!quadra || quadra.gestor_id !== gestorId) {
      return res.status(403).json({
        error: "Quadra não pertence a este gestor."
      });
    }

    // 2) Verificar conflito: mesma quadra + data + hora com status pending/paid
    const { data: reservasConflito, error: erroConflito } = await supabase
      .from("reservas")
      .select("id, status")
      .eq("quadra_id", quadraId)
      .eq("data", data)
      .eq("hora", hora)
      .in("status", ["pending", "paid", "pendente", "pago"]);


    if (erroConflito) {
      console.error(
        "[GESTOR/RESERVAS][CREATE] Erro ao checar conflito:",
        erroConflito
      );
      return res.status(500).json({
        error: "Erro ao verificar conflito de horário em /gestor/reservas."
      });
    }

    if (reservasConflito && reservasConflito.length > 0) {
      return res.status(409).json({
        error:
          "Já existe uma reserva para esta quadra nesta data e horário (painel ou WhatsApp)."
      });
    }

    const precoNumber =
      valor !== undefined && valor !== null ? Number(valor) : 0;

    // 3) Criar reserva confirmada (status = paid), mas sem PIX
    const { data: novaReserva, error: erroInsert } = await supabase
  .from("reservas")
  .insert([
    {
      quadra_id: quadraId,
      user_cpf: cpf,
      data,
      hora,
      status: "paid", // reserva confirmada pelo gestor
      preco_total: precoNumber, // estatística de aluguel direto
      pago_via_pix: false, // NÃO entra em repasse automático
      phone,
      origem: "painel", // <<< RESERVA CRIADA PELO PAINEL
      // usuario_id: null
    }
  ])
  .select("*")
  .single();


    if (erroInsert) {
      console.error(
        "[GESTOR/RESERVAS][CREATE] Erro ao inserir reserva:",
        erroInsert
      );
      return res.status(500).json({
        error: "Erro ao criar reserva no Supabase em /gestor/reservas."
      });
    }

    console.log("[GESTOR/RESERVAS][CREATE] Reserva criada via painel:", {
      gestorId,
      quadraId,
      data,
      hora,
      cpf,
      nome
    });

    return res.status(201).json(novaReserva);
  } catch (err) {
    console.error("[GESTOR/RESERVAS][CREATE] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno ao criar reserva pelo painel do gestor."
    });
  }
});

// -----------------------------------------
// PUT /gestor/reservas/:id → editar reserva (painel Gestor)
// - Permite alterar: quadra, data, hora, cpf, telefone, valor
// - NÃO permite editar reservas canceladas
// - Garante que a reserva pertence a uma quadra do gestor logado
// - Respeita a regra: pending/paid = reservado; cancelled = libera
// -----------------------------------------
app.put("/gestor/reservas/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = String(req.user?.id || "");
    const reservaId = req.params.id;
    const { quadraId, data, hora, cpf, phone, valor } = req.body || {};

    if (!gestorId) {
      return res
        .status(401)
        .json({ error: "Usuário gestor não identificado." });
    }

    if (!reservaId) {
      return res.status(400).json({
        error: "Parâmetro :id é obrigatório em /gestor/reservas/:id.",
      });
    }

    // 1) Buscar reserva + quadra associada para validar o dono
    const { data: reservaExistente, error: erroReserva } = await supabase
      .from("reservas")
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        user_cpf,
        phone,
        pago_via_pix,
        id_transacao_pix,
        quadras (
          id,
          gestor_id
        )
      `
      )
      .eq("id", reservaId)
      .single();

    if (erroReserva) {
      console.error(
        "[GESTOR/RESERVAS][UPDATE] Erro ao buscar reserva para edição:",
        erroReserva
      );
      return res.status(500).json({
        error: "Erro ao buscar reserva em /gestor/reservas/:id.",
      });
    }

    if (!reservaExistente) {
      return res.status(404).json({
        error: "Reserva não encontrada em /gestor/reservas/:id.",
      });
    }

    // Garantir que a reserva pertence a uma quadra do gestor logado
    const quadraReserva = reservaExistente.quadras;
    if (!quadraReserva || String(quadraReserva.gestor_id) !== gestorId) {
      return res.status(403).json({
        error:
          "Você não tem permissão para editar esta reserva (quadra não pertence ao gestor logado).",
      });
    }

    // Não permitir edição de reservas canceladas
    if (
      reservaExistente.status === "cancelled" ||
      reservaExistente.status === "canceled"
    ) {
      return res.status(400).json({
        error: "Não é possível editar uma reserva cancelada.",
      });
    }

    // Helper: normalizar hora para HH:MM (evita 18:00:00 vs 18:00)
    const normalizarHoraHHMM = (h) => {
      if (!h) return h;
      const s = String(h).trim();
      if (s.length >= 5) return s.slice(0, 5);
      return s;
    };

    // 2) Definir novos valores (fallback para o atual)
    const quadraIdNovo = quadraId || reservaExistente.quadra_id;
    const dataNova = data || reservaExistente.data;
    const horaNova = normalizarHoraHHMM(hora || reservaExistente.hora);
    const cpfNovo = cpf || reservaExistente.user_cpf;
    const phoneNovo = phone || reservaExistente.phone;

    // valor: se vier vazio/null/NaN, salva null (não força 0)
    let valorNovo = null;
    if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
      const n = Number(valor);
      valorNovo = Number.isFinite(n) ? n : null;
    } else if (reservaExistente.preco_total !== undefined && reservaExistente.preco_total !== null) {
      const n = Number(reservaExistente.preco_total);
      valorNovo = Number.isFinite(n) ? n : null;
    }

    // 3) Se mudou a quadra, conferir se a nova quadra também é do gestor
    if (quadraId && quadraId !== reservaExistente.quadra_id) {
      const { data: quadraNova, error: erroQuadraNova } = await supabase
        .from("quadras")
        .select("id, gestor_id")
        .eq("id", quadraIdNovo)
        .single();

      if (erroQuadraNova) {
        console.error(
          "[GESTOR/RESERVAS][UPDATE] Erro ao validar nova quadra:",
          erroQuadraNova
        );
        return res.status(500).json({
          error:
            "Erro ao validar a nova quadra em /gestor/reservas/:id (PUT).",
        });
      }

      if (!quadraNova || String(quadraNova.gestor_id) !== gestorId) {
        return res.status(403).json({
          error:
            "Você não pode mover a reserva para uma quadra que não pertence ao gestor logado.",
        });
      }
    }

    // 4) Verificar conflito de horário na nova quadra/data/hora
    // Regra: qualquer reserva pending ou paid bloqueia o horário
    const { data: conflito, error: erroConflito } = await supabase
      .from("reservas")
      .select("id, status")
      .eq("quadra_id", quadraIdNovo)
      .eq("data", dataNova)
      .eq("hora", horaNova)
      .in("status", ["pending", "paid"])
      .neq("id", reservaId)
      .maybeSingle();

    if (erroConflito) {
      console.error(
        "[GESTOR/RESERVAS][UPDATE] Erro ao checar conflito:",
        erroConflito
      );
      return res.status(500).json({
        error: "Erro ao verificar conflito de horário em /gestor/reservas/:id.",
      });
    }

    if (conflito) {
      return res.status(409).json({
        error: "HORARIO_OCUPADO",
        detalhe:
          "Já existe outra reserva ativa (pending/paid) para esta quadra nesta data e horário.",
      });
    }

    // 5) Atualizar a reserva
    const { data: reservaAtualizada, error: erroUpdate } = await supabase
      .from("reservas")
      .update({
        quadra_id: quadraIdNovo,
        data: dataNova,
        hora: horaNova,
        user_cpf: cpfNovo,
        phone: phoneNovo,
        preco_total: valorNovo,
      })
      .eq("id", reservaId)
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        user_cpf,
        phone
      `
      )
      .single();

    if (erroUpdate) {
      console.error(
        "[GESTOR/RESERVAS][UPDATE] Erro ao atualizar reserva:",
        erroUpdate
      );
      return res.status(500).json({
        error: "Erro ao atualizar reserva em /gestor/reservas/:id.",
      });
    }

    console.log(
      "[GESTOR/RESERVAS][UPDATE] Reserva editada com sucesso:",
      reservaAtualizada
    );

    return res.json(reservaAtualizada);
  } catch (err) {
    console.error("[GESTOR/RESERVAS][UPDATE] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno ao editar reserva pelo painel do gestor.",
    });
  }
});


// -----------------------------------------
// GET /gestor/reservas/:id  → detalhe de uma reserva do gestor
// Usado para preencher o card de "Editar/Cancelar Reserva"
// -----------------------------------------
app.get("/gestor/reservas/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;
    const { id: reservaId } = req.params;

    if (!gestorId) {
      return res.status(400).json({
        error: "Token inválido em /gestor/reservas/:id (GET).",
      });
    }

    if (!reservaId) {
      return res.status(400).json({
        error: "Parâmetro id é obrigatório em /gestor/reservas/:id (GET).",
      });
    }

    // 1) Busca reserva
    const { data: reserva, error: reservaError } = await supabase
      .from("reservas")
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        user_cpf,
        phone,
        usuario_id
      `
      )
      .eq("id", reservaId)
      .single();

    if (reservaError) {
      console.error(
        "[GESTOR/RESERVAS][GET/:id] Erro ao buscar reserva:",
        reservaError
      );
      return res.status(500).json({
        error: "Erro ao buscar reserva em /gestor/reservas/:id (GET).",
      });
    }

    if (!reserva) {
      return res.status(404).json({
        error: "Reserva não encontrada em /gestor/reservas/:id (GET).",
      });
    }

    // 2) Garante que a quadra da reserva pertence ao gestor logado
    try {
      await validarQuadraDoGestor(reserva.quadra_id, gestorId);
    } catch (errValid) {
      console.error(
        "[GESTOR/RESERVAS][GET/:id] Quadra não pertence ao gestor:",
        errValid
      );
      return res.status(403).json({
        error: "Reserva não pertence a uma quadra deste gestor.",
      });
    }

    // 3) Busca detalhes da quadra + empresa (para mostrar no card)
    const { data: quadra, error: quadraError } = await supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        empresa_id,
        empresas (
          id,
          nome,
          descricao_complexo,
          endereco_resumo
        )
      `
      )
      .eq("id", reserva.quadra_id)
      .maybeSingle();

    if (quadraError) {
      console.error(
        "[GESTOR/RESERVAS][GET/:id] Erro ao buscar quadra/empresa:",
        quadraError
      );
      // não bloqueia totalmente: devolve só reserva
    }

    return res.json({
      reserva,
      quadra, // pode ser null se der erro, mas normalmente vem preenchido
    });
  } catch (err) {
    console.error("[GESTOR/RESERVAS][GET/:id] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno em /gestor/reservas/:id (GET).",
    });
  }
});


// -----------------------------------------
// PATCH /gestor/reservas/:id/cancelar → cancelar reserva (painel Gestor)
// - Marca a reserva como "cancelled"
// - Libera o horário na lógica de disponibilidade
// - Mantém a reserva para estatísticas de cancelamento
// -----------------------------------------
app.patch(
  "/gestor/reservas/:id/cancelar",
  autenticarPainel,
  async (req, res) => {
    try {
      const gestorId = req.user.id;
      const reservaId = req.params.id;

      if (!gestorId) {
        return res
          .status(401)
          .json({ error: "Usuário gestor não identificado." });
      }

      if (!reservaId) {
        return res.status(400).json({
          error:
            "Parâmetro :id é obrigatório em PATCH /gestor/reservas/:id/cancelar."
        });
      }

      // 1) Buscar reserva + quadra associada
      const { data: reservaExistente, error: erroReserva } = await supabase
        .from("reservas")
        .select(
          `
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total,
          quadras (
            id,
            gestor_id
          )
        `
        )
        .eq("id", reservaId)
        .single();

      if (erroReserva) {
        console.error(
          "[GESTOR/RESERVAS][CANCEL] Erro ao buscar reserva:",
          erroReserva
        );
        return res.status(500).json({
          error: "Erro ao buscar reserva em /gestor/reservas/:id/cancelar."
        });
      }

      if (!reservaExistente) {
        return res.status(404).json({
          error: "Reserva não encontrada."
        });
      }

      const quadraDaReserva = reservaExistente.quadras;

      if (!quadraDaReserva || quadraDaReserva.gestor_id !== gestorId) {
        return res.status(403).json({
          error: "Esta reserva não pertence a uma quadra deste gestor."
        });
      }

      if (
        reservaExistente.status === "cancelled" ||
        reservaExistente.status === "canceled"
      ) {
        // Já está cancelada → apenas retorna o registro
        return res.json(reservaExistente);
      }

      // 2) Marcar como cancelada
      const { data: reservaCancelada, error: erroUpdate } = await supabase
        .from("reservas")
.update({
  status: "canceled",
  updated_at: new Date().toISOString(),
        })
        .eq("id", reservaId)
        .select("*")
        .single();

      if (erroUpdate) {
        console.error(
          "[GESTOR/RESERVAS][CANCEL] Erro ao cancelar reserva:",
          erroUpdate
        );
        return res.status(500).json({
          error:
            "Erro ao cancelar reserva em /gestor/reservas/:id/cancelar."
        });
      }

      console.log("[GESTOR/RESERVAS][CANCEL] Reserva cancelada via painel:", {
        gestorId,
        reservaId,
        quadra_id: reservaCancelada.quadra_id,
        data: reservaCancelada.data,
        hora: reservaCancelada.hora
      });

      return res.json(reservaCancelada);
    } catch (err) {
      console.error("[GESTOR/RESERVAS][CANCEL] Erro inesperado:", err);
      return res.status(500).json({
        error: "Erro interno ao cancelar reserva pelo painel do gestor."
      });
    }
  }
);

// -----------------------------------------
// DELETE /gestor/reservas/:id  → cancelar reserva (soft delete)
// - PADRÃO: status reservas = pending|paid|canceled
// - Cancela pagamento/repasses vinculados (se existirem) -> status="canceled"
// - Libera o horário na agenda (slots só consideram pending/paid como ocupando)
// -----------------------------------------
app.delete("/gestor/reservas/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user?.id;
    const reservaId = req.params?.id;

    if (!gestorId) {
      return res.status(401).json({
        error: "Token inválido em /gestor/reservas/:id (DELETE).",
      });
    }

    if (!reservaId) {
      return res.status(400).json({
        error: "Parâmetro id é obrigatório em /gestor/reservas/:id (DELETE).",
      });
    }

    // ==========================================================
    // Helpers locais (não dependem de nada externo)
    // ==========================================================
    function normalizeReservaStatus(s) {
      const v = String(s || "").toLowerCase().trim();
      if (!v) return "pending";

      // PT antigos
      if (v === "pendente") return "pending";
      if (v === "pago") return "paid";
      if (v === "cancelado") return "canceled";

      // EN antigo
      if (v === "cancelled") return "canceled";

      if (v === "pending" || v === "paid" || v === "canceled") return v;

      // fallback conservador: ocupa
      return "pending";
    }

    // 1) Busca reserva
    const { data: reserva, error: reservaError } = await supabase
      .from("reservas")
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        origem,
        user_cpf,
        phone,
        usuario_id
      `
      )
      .eq("id", reservaId)
      .single();

    if (reservaError) {
      console.error("[GESTOR/RESERVAS][DEL/:id] Erro ao buscar reserva:", reservaError);
      return res.status(500).json({
        error: "Erro ao buscar reserva em /gestor/reservas/:id (DELETE).",
      });
    }

    if (!reserva) {
      return res.status(404).json({
        error: "Reserva não encontrada em /gestor/reservas/:id (DELETE).",
      });
    }

    // 2) Garante que a reserva é de uma quadra do gestor logado
    try {
      await validarQuadraDoGestor(reserva.quadra_id, gestorId);
    } catch (errValid) {
      console.error("[GESTOR/RESERVAS][DEL/:id] Quadra não pertence ao gestor:", errValid);
      return res.status(403).json({
        error: "Reserva não pertence a uma quadra deste gestor.",
      });
    }

    // 3) Se já estiver cancelada (canceled), evita operação repetida
    if (normalizeReservaStatus(reserva.status) === "canceled") {
      return res.status(409).json({
        error: "RESERVA_JA_CANCELADA",
        detalhe: "Esta reserva já está com status canceled.",
      });
    }

    // ==========================================================
    // 3.1) Se houver pagamento vinculado e estiver paid, cancelar
    //      e cancelar repasses vinculados (se existirem)
    // ==========================================================
    let pagamentoVinculado = null;
    let repassesAfetados = [];

    try {
      const { data: pag, error: pagError } = await supabase
        .from("pagamentos")
        .select("id,status,reserva_id,mp_payment_id")
        .eq("reserva_id", reservaId)
        .maybeSingle();

      if (pagError) {
        console.warn("[GESTOR/RESERVAS][DEL/:id] Aviso ao buscar pagamento vinculado:", pagError);
      } else if (pag) {
        pagamentoVinculado = pag;

        const statusPag = String(pag.status || "").toLowerCase().trim();
        const ehPaid = statusPag === "paid";

        if (ehPaid) {
          // 1) Marca pagamento como canceled
          const { error: updPagErr } = await supabase
            .from("pagamentos")
            .update({
              status: "canceled",
              updated_at: new Date().toISOString(),
            })
            .eq("id", pag.id);

          if (updPagErr) {
            console.warn("[GESTOR/RESERVAS][DEL/:id] Aviso ao cancelar pagamento:", updPagErr);
          }

          // 2) Descobre repasses ligados a esse pagamento e marca como canceled
          const { data: links, error: linksErr } = await supabase
            .from("repasses_pagamentos")
            .select("repasse_id,pagamento_id")
            .eq("pagamento_id", pag.id);

          if (linksErr) {
            console.warn("[GESTOR/RESERVAS][DEL/:id] Aviso ao buscar repasses_pagamentos:", linksErr);
          } else {
            const repasseIds = (links || [])
              .map((x) => x.repasse_id)
              .filter(Boolean);

            repassesAfetados = repasseIds;

            if (repasseIds.length) {
              const { error: updRepErr } = await supabase
                .from("repasses")
                .update({
                  status: "canceled",
                  updated_at: new Date().toISOString(),
                })
                .in("id", repasseIds);

              if (updRepErr) {
                console.warn("[GESTOR/RESERVAS][DEL/:id] Aviso ao cancelar repasse(s):", updRepErr);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(
        "[GESTOR/RESERVAS][DEL/:id] Aviso: falha inesperada no bloco de pagamentos/repasses (não bloqueia o cancelamento):",
        e
      );
    }

    // 4) Atualiza reserva para status "canceled" (soft delete)
    const { data: reservaAtualizada, error: updateError } = await supabase
      .from("reservas")
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", reservaId)
      .neq("status", "canceled") // idempotência
      .select(
        `
        id,
        quadra_id,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        user_cpf,
        phone,
        usuario_id,
        origem
      `
      )
      .single();

    if (updateError) {
      console.error("[GESTOR/RESERVAS][DEL/:id] Erro ao cancelar reserva:", updateError);
      return res.status(500).json({
        error: "Erro ao cancelar reserva em /gestor/reservas/:id (DELETE).",
      });
    }

    return res.json({
      message: "Reserva cancelada com sucesso.",
      reserva: reservaAtualizada,
      pagamento: pagamentoVinculado
        ? {
            id: pagamentoVinculado.id,
            mp_payment_id: pagamentoVinculado.mp_payment_id || null,
            status_anterior: pagamentoVinculado.status,
          }
        : null,
      repasses_afetados: repassesAfetados,
    });
  } catch (err) {
    console.error("[GESTOR/RESERVAS][DEL/:id] Erro inesperado:", err);
    return res.status(500).json({
      error: "Erro interno em /gestor/reservas/:id (DELETE).",
    });
  }
});

// ==========================================================
// ADMIN — RESERVAS (GLOBAL)
// - Admin enxerga tudo
// - Admin cria/edita/cancela
// - Reservas do painel: origem="painel" e status="pending" (não gera financeiro/repasses)
// - Anti-duplicidade: bloqueia mesmo slot quando status != "canceled"
// ==========================================================

// helper local (não depende de nada externo)
function isOcupando(status) {
  return String(status || "").toLowerCase() !== "canceled";
}

// -----------------------------------------
// GET /admin/reservas
// Query (opcionais):
//  - inicio=YYYY-MM-DD
//  - fim=YYYY-MM-DD
//  - status=pending|paid|canceled
//  - origem=painel|whatsapp
//  - gestorId=UUID
//  - empresaId=UUID
//  - quadraId=UUID
//  - cpf=texto
//  - phone=texto
// -----------------------------------------
app.get("/admin/reservas", autenticarPainel, garantirAdmin, async (req, res) => {
  try {
    const {
      inicio,
      fim,
      status,
      origem,
      gestorId,
      empresaId,
      quadraId,
      cpf,
      phone
    } = req.query || {};

    let q = supabase
      .from("reservas")
      .select(
        `
        id,
        quadra_id,
        user_cpf,
        data,
        hora,
        status,
        preco_total,
        pago_via_pix,
        created_at,
        phone,
        id_transacao_pix,
        usuario_id,
        origem,
        quadras (
          id,
          tipo,
          material,
          modalidade,
          gestor_id,
          empresa_id,
          taxa_plataforma_override,
          empresas (
            id,
            nome,
            gestor_id
          )
        )
        `
      )
      .order("created_at", { ascending: false });

    if (status) q = q.eq("status", status);
    if (origem) q = q.eq("origem", origem);
    if (quadraId) q = q.eq("quadra_id", quadraId);
    if (cpf) q = q.ilike("user_cpf", `%${cpf}%`);
    if (phone) q = q.ilike("phone", `%${phone}%`);

    // filtro por período (coluna "data" da reserva)
    if (inicio) q = q.gte("data", inicio);
    if (fim) q = q.lte("data", fim);

    // filtro por gestor/empresa (via relacionamento de quadras)
    if (gestorId) q = q.eq("quadras.gestor_id", gestorId);
    if (empresaId) q = q.eq("quadras.empresa_id", empresaId);

    const { data: itens, error } = await q;

    if (error) {
      console.error("[ADMIN/RESERVAS][GET] Erro:", error);
      return res.status(500).json({ error: "Erro ao listar reservas (admin)." });
    }

    return res.json({ itens: itens || [] });
  } catch (err) {
    console.error("[ADMIN/RESERVAS][GET] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro ao listar reservas (admin)." });
  }
});

// -----------------------------------------
// POST /admin/reservas
// Body:
//  - quadraId (obrigatório)
//  - data (YYYY-MM-DD) obrigatório
//  - hora (ex: "18:00") obrigatório
//  - cpf (opcional)
//  - phone (opcional)
//  - preco_total (opcional)
// Regras (PADRÃO PAINEL):
// - origem="painel"
// - status="paid" (CONFIRMADA no ato, igual painel do gestor)
// - NÃO cria pagamentos / NÃO gera repasse (pago_via_pix=false)
// - Anti-duplicidade: bloqueia se já existir reserva no mesmo slot com status != canceled
// -----------------------------------------
app.post("/admin/reservas", autenticarPainel, garantirAdmin, async (req, res) => {
  try {
    const { quadraId, data, hora, cpf, phone, preco_total } = req.body || {};

    if (!quadraId || !data || !hora) {
      return res.status(400).json({ error: "quadraId, data e hora são obrigatórios." });
    }

    // 1) Anti-duplicidade (ocupa slot se status != canceled)
    const { data: existe, error: exErr } = await supabase
      .from("reservas")
      .select("id, status")
      .eq("quadra_id", quadraId)
      .eq("data", data)
      .eq("hora", hora)
      .limit(1);

    if (exErr) {
      console.error("[ADMIN/RESERVAS][POST] Erro ao checar duplicidade:", exErr);
      return res.status(500).json({ error: "Erro ao validar disponibilidade do horário." });
    }

    if (existe && existe.length && isOcupando(existe[0].status)) {
      return res.status(409).json({ error: "Horário já reservado para esta quadra (pending/paid)." });
    }

    // 2) Cria reserva manual/painel (CONFIRMADA)
    const payload = {
      quadra_id: quadraId,
      user_cpf: cpf || null,
      phone: phone || null,
      data,
      hora,

      // ✅ PADRÃO PAINEL
      status: "paid",
      origem: "painel",

      preco_total: Number(preco_total || 0),

      // ✅ NÃO entra em financeiro/repasses
      pago_via_pix: false,
      id_transacao_pix: null
    };

    const { data: criada, error: insErr } = await supabase
      .from("reservas")
      .insert([payload])
      .select(
        `
        id,
        quadra_id,
        user_cpf,
        data,
        hora,
        status,
        preco_total,
        created_at,
        phone,
        origem,
        pago_via_pix,
        id_transacao_pix,
        quadras (
          id,
          tipo,
          material,
          modalidade,
          gestor_id,
          empresa_id,
          empresas ( id, nome )
        )
        `
      )
      .single();

    if (insErr) {
      console.error("[ADMIN/RESERVAS][POST] Erro ao inserir:", insErr);
      return res.status(500).json({ error: "Erro ao criar reserva (admin)." });
    }

    return res.status(201).json({ item: criada });
  } catch (err) {
    console.error("[ADMIN/RESERVAS][POST] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro ao criar reserva (admin)." });
  }
});



// -----------------------------------------
// PUT /admin/reservas/:id
// Body (qualquer um):
//  - quadraId, data, hora, cpf, phone, preco_total
//
// Regras:
// - mantém origem="painel" para reservas criadas no painel
// - NÃO permite setar paid manualmente aqui (status não é editável por essa rota)
// - Anti-duplicidade ao mudar slot (quadra/data/hora)
// -----------------------------------------
app.put("/admin/reservas/:id", autenticarPainel, garantirAdmin, async (req, res) => {
  try {
    const reservaId = req.params.id;
    const { quadraId, data, hora, cpf, phone, preco_total } = req.body || {};

    // 1) Carrega reserva atual
    const { data: atual, error: atErr } = await supabase
      .from("reservas")
      .select("id, quadra_id, data, hora, status, origem")
      .eq("id", reservaId)
      .single();

    if (atErr || !atual) {
      return res.status(404).json({ error: "Reserva não encontrada." });
    }

    // 2) Se mudar slot, valida duplicidade
    const novoQuadraId = quadraId || atual.quadra_id;
    const novaData = data || atual.data;
    const novaHora = hora || atual.hora;

    const mudouSlot =
      String(novoQuadraId) !== String(atual.quadra_id) ||
      String(novaData) !== String(atual.data) ||
      String(novaHora) !== String(atual.hora);

    if (mudouSlot) {
      const { data: existe, error: exErr } = await supabase
        .from("reservas")
        .select("id, status")
        .eq("quadra_id", novoQuadraId)
        .eq("data", novaData)
        .eq("hora", novaHora)
        .neq("id", reservaId)
        .limit(1);

      if (exErr) {
        console.error("[ADMIN/RESERVAS][PUT] Erro ao checar duplicidade:", exErr);
        return res.status(500).json({ error: "Erro ao validar disponibilidade do horário." });
      }

      if (existe && existe.length && isOcupando(existe[0].status)) {
        return res.status(409).json({ error: "Horário já reservado para esta quadra (pending/paid)." });
      }
    }

    // 3) Atualiza campos permitidos (status NÃO)
    const patch = {
      quadra_id: novoQuadraId,
      data: novaData,
      hora: novaHora,
      user_cpf: cpf !== undefined ? (cpf || null) : undefined,
      phone: phone !== undefined ? (phone || null) : undefined,
      preco_total: preco_total !== undefined ? Number(preco_total || 0) : undefined,
      updated_at: new Date().toISOString()
    };

    // remove undefined
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    const { data: atualizado, error: upErr } = await supabase
      .from("reservas")
      .update(patch)
      .eq("id", reservaId)
      .select(
        `
        id,
        quadra_id,
        user_cpf,
        data,
        hora,
        status,
        preco_total,
        created_at,
        phone,
        origem,
        quadras (
          id,
          tipo,
          material,
          modalidade,
          gestor_id,
          empresa_id,
          empresas ( id, nome )
        )
        `
      )
      .single();

    if (upErr) {
      console.error("[ADMIN/RESERVAS][PUT] Erro ao atualizar:", upErr);
      return res.status(500).json({ error: "Erro ao atualizar reserva (admin)." });
    }

    return res.json({ item: atualizado });
  } catch (err) {
    console.error("[ADMIN/RESERVAS][PUT] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro ao atualizar reserva (admin)." });
  }
});

// -----------------------------------------
// DELETE /admin/reservas/:id  (cancelamento "soft")
// Regra: vira status="canceled"
// -----------------------------------------
app.delete("/admin/reservas/:id", autenticarPainel, garantirAdmin, async (req, res) => {
  try {
    const reservaId = req.params.id;

    const { data: atualizado, error } = await supabase
      .from("reservas")
      .update({
  status: "canceled",
  updated_at: new Date().toISOString(),
})
.eq("id", reservaId)
.neq("status", "canceled") // ✅ não reprocessa se já estava cancelada
.select("id, status")
.maybeSingle();


    if (error) {
      console.error("[ADMIN/RESERVAS][DELETE] Erro:", error);
      return res.status(500).json({ error: "Erro ao cancelar reserva (admin)." });
    }

    return res.json({ ok: true, item: atualizado });
  } catch (err) {
    console.error("[ADMIN/RESERVAS][DELETE] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro ao cancelar reserva (admin)." });
  }
});


// ============================================================================
// BLOCO AGENDA – VISÃO "CINEMA" (GRID DE SLOTS) PARA O PAINEL DO GESTOR
// ============================================================================
//
// GET /gestor/agenda/grid
// Query params:
//   - quadraId (obrigatório): UUID da quadra
//   - from     (opcional): data inicial (AAAA-MM-DD ou DD/MM/AAAA). Default = hoje
//   - to       (opcional): data final   (AAAA-MM-DD ou DD/MM/AAAA). Default = hoje+6 dias (7 dias no total)
//
// Retorno:
// {
//   quadraId: "...",
//   from: "2025-12-10",
//   to: "2025-12-16",
//   dias: [
//     {
//       data: "2025-12-10",
//       dia_da_semana: 3, // 0=Dom .. 6=Sáb
//       slots: [
//         {
//           horario: "18:00-19:00",
//           hora_inicio: "18:00",
//           hora_fim: "19:00",
//           status: "LIVRE" | "RESERVADO" | "BLOQUEADO",
//           reserva_id: "... ou null",
//           reserva_status: "pending" | "paid" | null,
//           preco: 80.0
//         }
//       ]
//     },
//     ...
//   ]
// }
// ============================================================================

app.get(
  "/gestor/agenda/grid",
  authPainel,
  permitirTipos("GESTOR"),
  async (req, res) => {
    // Helpers internos da rota
    function normalizarDataQuery(str) {
      if (!str) return null;
      const s = String(str).trim();
      try {
        // Aceita DD/MM/AAAA usando helper existente
        if (s.includes("/")) {
          const dt = parseDataAgendamentoBr(s);
          return formatDateISO(dt);
        }

        // Aceita AAAA-MM-DD
        if (s.includes("-")) {
          const [anoStr, mesStr, diaStr] = s.split("-");
          const ano = parseInt(anoStr, 10);
          const mes = parseInt(mesStr, 10);
          const dia = parseInt(diaStr, 10);
          const dt = new Date(ano, mes - 1, dia);
          if (Number.isNaN(dt.getTime())) return null;
          return formatDateISO(dt);
        }

        return null;
      } catch (_) {
        return null;
      }
    }

    function gerarIntervaloDatas(isoInicio, isoFimInclusivo) {
      const dias = [];
      const [a1, m1, d1] = isoInicio.split("-").map((n) => parseInt(n, 10));
      const [a2, m2, d2] = isoFimInclusivo.split("-").map((n) => parseInt(n, 10));

      let dt = new Date(a1, m1 - 1, d1);
      const dtFim = new Date(a2, m2 - 1, d2);

      // Normaliza hora para meia-noite
      dt.setHours(0, 0, 0, 0);
      dtFim.setHours(0, 0, 0, 0);

      while (dt.getTime() <= dtFim.getTime()) {
        dias.push({
          iso: formatDateISO(dt),
          diaSemana: dt.getDay(), // 0=Dom .. 6=Sáb (mesmo padrão de regras_horarios)
        });
        dt.setDate(dt.getDate() + 1);
      }

      return dias;
    }

    function horaParaMinutos(horaStr) {
      if (!horaStr) return null;
      const [hStr, mStr] = String(horaStr).split(":");
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr || "0", 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    }

    function slotEstaBloqueado(horaInicioSlot, bloqueiosDoDia) {
      const minSlot = horaParaMinutos(horaInicioSlot);
      if (minSlot === null) return false;

      for (const b of bloqueiosDoDia) {
        // Se não tiver hora_inicio/hora_fim, consideramos bloqueio do dia inteiro
        const minIni =
          b.hora_inicio != null ? horaParaMinutos(b.hora_inicio) : 0;
        const minFim =
          b.hora_fim != null ? horaParaMinutos(b.hora_fim) : 24 * 60;

        if (minIni === null || minFim === null) continue;

        // Slot considerado bloqueado se o início dele estiver dentro do intervalo
        if (minSlot >= minIni && minSlot < minFim) {
          return true;
        }
      }

      return false;
    }

    try {
      const gestorId = req.usuarioPainel.id;
      const { quadraId, from, to } = req.query || {};

      if (!quadraId) {
        return res.status(400).json({
          error: "Parâmetro quadraId é obrigatório em /gestor/agenda/grid.",
        });
      }

      // Garante que a quadra pertence a este gestor
      await validarQuadraDoGestor(quadraId, gestorId);

      // Define período padrão (7 dias a partir de hoje) se nada for enviado
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      let fromISO = normalizarDataQuery(from) || formatDateISO(hoje);

      let dtFimDefault = new Date(hoje);
      dtFimDefault.setDate(dtFimDefault.getDate() + 6);
      let toISO = normalizarDataQuery(to) || formatDateISO(dtFimDefault);

      if (!fromISO || !toISO) {
        return res.status(400).json({
          error:
            "Datas inválidas em /gestor/agenda/grid. Use AAAA-MM-DD ou DD/MM/AAAA.",
        });
      }

      // Se vier invertido, corrige (from <= to)
      if (fromISO > toISO) {
        const tmp = fromISO;
        fromISO = toISO;
        toISO = tmp;
      }

      const intervalo = gerarIntervaloDatas(fromISO, toISO);
      if (!intervalo || intervalo.length === 0) {
        return res.status(400).json({
          error: "Intervalo de datas vazio em /gestor/agenda/grid.",
        });
      }

      const diasSemanaUnicos = [
        ...new Set(intervalo.map((d) => d.diaSemana)),
      ];

      // 1) Busca regras de horário (grade base)
      const { data: regras, error: regrasError } = await supabase
        .from("regras_horarios")
        .select(
          `
          id,
          id_quadra,
          dia_da_semana,
          hora_inicio,
          hora_fim,
          valor
        `
        )
        .eq("id_quadra", quadraId)
        .in("dia_da_semana", diasSemanaUnicos)
        .order("dia_da_semana", { ascending: true })
        .order("hora_inicio", { ascending: true });

      if (regrasError) {
        console.error(
          "[AGENDA/GRID][REGRAS] Erro ao buscar regras:",
          regrasError
        );
        return res.status(500).json({
          error: "Erro ao buscar regras de horário em /gestor/agenda/grid.",
        });
      }

      // 2) Busca reservas no período (pending/paid contam como ocupadas)
      const { data: reservas, error: reservasError } = await supabase
        .from("reservas")
        .select(
          `
          id,
          quadra_id,
          data,
          hora,
          status,
          preco_total
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", fromISO)
        .lte("data", toISO);

      if (reservasError) {
        console.error(
          "[AGENDA/GRID][RESERVAS] Erro ao buscar reservas:",
          reservasError
        );
        return res.status(500).json({
          error: "Erro ao buscar reservas em /gestor/agenda/grid.",
        });
      }

      // 3) Busca bloqueios no período
      const { data: bloqueios, error: bloqueiosError } = await supabase
        .from("bloqueios_quadra")
        .select(
          `
          id,
          quadra_id,
          data,
          hora_inicio,
          hora_fim,
          motivo
        `
        )
        .eq("quadra_id", quadraId)
        .gte("data", fromISO)
        .lte("data", toISO);

      if (bloqueiosError) {
        console.error(
          "[AGENDA/GRID][BLOQUEIOS] Erro ao buscar bloqueios:",
          bloqueiosError
        );
        return res.status(500).json({
          error: "Erro ao buscar bloqueios em /gestor/agenda/grid.",
        });
      }

      const regrasArr = regras || [];
      const reservasArr = reservas || [];
      const bloqueiosArr = bloqueios || [];

      // 4) Monta a grade dia a dia
      const diasSaida = intervalo.map((dia) => {
        const dataISO = dia.iso;

        const regrasDoDia = regrasArr.filter(
          (r) => r.dia_da_semana === dia.diaSemana
        );

        const reservasDoDia = reservasArr.filter(
          (r) => r.data === dataISO
        );

        const bloqueiosDoDia = bloqueiosArr.filter(
          (b) => b.data === dataISO
        );

        const slots = regrasDoDia.map((regra) => {
          const horaIniStr = regra.hora_inicio.slice(0, 5);
          const horaFimStr = regra.hora_fim.slice(0, 5);

          const bloqueado = slotEstaBloqueado(
            horaIniStr,
            bloqueiosDoDia
          );

          const reservaSlot = reservasDoDia.find(
            (r) =>
              r.hora &&
              r.hora.slice(0, 5) === horaIniStr &&
              ["pending", "paid"].includes(r.status)
          );

          let statusSlot = "LIVRE";
          if (bloqueado) {
            statusSlot = "BLOQUEADO"; // cinza no frontend
          } else if (reservaSlot) {
            statusSlot = "RESERVADO"; // vermelho no frontend
          }

          return {
            horario: `${horaIniStr}-${horaFimStr}`,
            hora_inicio: horaIniStr,
            hora_fim: horaFimStr,
            status: statusSlot, // LIVRE | RESERVADO | BLOQUEADO
            reserva_id: reservaSlot ? reservaSlot.id : null,
            reserva_status: reservaSlot ? reservaSlot.status : null,
            preco: regra.valor,
          };
        });

        return {
          data: dataISO,
          dia_da_semana: dia.diaSemana,
          slots,
        };
      });

      return res.json({
        quadraId,
        from: fromISO,
        to: toISO,
        dias: diasSaida,
      });
    } catch (err) {
      console.error("[AGENDA/GRID] Erro geral:", err);
      return res.status(500).json({
        error: "Erro interno em /gestor/agenda/grid.",
      });
    }
  }
);


// -----------------------------------------
// GET /gestor/quadras/:id  → detalhes de uma quadra do gestor
// Query: ?gestorId=UUID
// -----------------------------------------
app.get("/gestor/quadras/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;
    const { id: quadraId } = req.params;

    if (!gestorId) {
      return res.status(400).json({
        error: "Parâmetro gestorId é obrigatório em /gestor/quadras/:id"
      });
    }

    const { data, error } = await supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id
      `
      )
      .eq("id", quadraId)
      .eq("gestor_id", gestorId)
      .single();

    if (error) {
      console.error("[GESTOR QUADRA DETALHE] Erro ao buscar quadra:", error);
      return res.status(500).json({
        error: "Erro ao buscar quadra do gestor",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Quadra não encontrada para este gestor"
      });
    }

    const quadraComNome = {
      ...data,
      nome_dinamico: buildNomeQuadraDinamico(data)
    };

    return res.status(200).json(quadraComNome);
  } catch (err) {
    console.error("[GESTOR QUADRA DETALHE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /gestor/quadras/:id",
      detail: err.message
    });
  }
});


// -----------------------------------------
// PUT /gestor/quadras/:id  → editar textos/imagens da quadra do gestor
// Body: JSON com campos permitidos em buildQuadraUpdateBody
// Query: ?gestorId=UUID
// -----------------------------------------
app.put("/gestor/quadras/:id", autenticarPainel, async (req, res) => {
  try {
    const { gestorId } = req.query;
    const { id: quadraId } = req.params;

    if (!gestorId) {
      return res.status(400).json({
        error:
          "Parâmetro gestorId é obrigatório em /gestor/quadras/:id (PUT)"
      });
    }

    const updates = buildQuadraUpdateBody(req.body);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "Nenhum campo válido para atualização foi enviado"
      });
    }

    const { data, error } = await supabase
      .from("quadras")
      .update(updates)
      .eq("id", quadraId)
      .eq("gestor_id", gestorId)
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id
      `
      )
      .single();

    if (error) {
      console.error("[GESTOR QUADRA UPDATE] Erro ao atualizar quadra:", error);
      return res.status(500).json({
        error: "Erro ao atualizar quadra do gestor",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Quadra não encontrada para este gestor"
      });
    }

    const quadraComNome = {
      ...data,
      nome_dinamico: buildNomeQuadraDinamico(data)
    };

    return res.status(200).json(quadraComNome);
  } catch (err) {
    console.error("[GESTOR QUADRA UPDATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /gestor/quadras/:id (PUT)",
      detail: err.message
    });
  }
});

// -----------------------------------------
// GET /admin/quadras  → lista todas as quadras (Admin)
// -----------------------------------------
app.get(
  "/admin/quadras",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id
      `
      )
      .order("tipo", { ascending: true })
      .order("material", { ascending: true })
      .order("modalidade", { ascending: true });

    if (error) {
      console.error("[ADMIN QUADRAS] Erro ao listar quadras:", error);
      return res.status(500).json({
        error: "Erro ao listar quadras (admin)",
        detail: error.message
      });
    }

    const quadras = (data || []).map((q) => ({
      ...q,
      nome_dinamico: buildNomeQuadraDinamico(q)
    }));

    return res.status(200).json({
      quadras
    });
  } catch (err) {
    console.error("[ADMIN QUADRAS] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/quadras",
      detail: err.message
    });
  }
});


// -----------------------------------------
// GET /admin/quadras/:id  → detalhe de uma quadra (Admin)
// -----------------------------------------
app.get(
  "/admin/quadras/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { id: quadraId } = req.params;

    const { data, error } = await supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id
      `
      )
      .eq("id", quadraId)
      .single();

    if (error) {
      console.error("[ADMIN QUADRA DETALHE] Erro ao buscar quadra:", error);
      return res.status(500).json({
        error: "Erro ao buscar quadra (admin)",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Quadra não encontrada"
      });
    }

    const quadraComNome = {
      ...data,
      nome_dinamico: buildNomeQuadraDinamico(data)
    };

    return res.status(200).json(quadraComNome);
  } catch (err) {
    console.error("[ADMIN QUADRA DETALHE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/quadras/:id",
      detail: err.message
    });
  }
});


// -----------------------------------------
// PUT /admin/quadras/:id  → Admin pode editar qualquer quadra
// -----------------------------------------
app.put(
  "/admin/quadras/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { id: quadraId } = req.params;

    const updatesBase = buildQuadraUpdateBody(req.body);
    const updates = { ...updatesBase }; // espalha os campos permitidos

    // Admin também pode reatribuir gestor se quiser
    if (req.body && req.body.gestor_id) {
      updates.gestor_id = req.body.gestor_id;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "Nenhum campo válido para atualização foi enviado (admin)"
      });
    }

    const { data, error } = await supabase
      .from("quadras")
      .update(updates)
      .eq("id", quadraId)
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        informacoes,
        aviso,
        url_imagem_header,
        url_imagem_2,
        url_imagem_3,
        gestor_id,
        empresa_id
      `
      )
      .single();

    if (error) {
      console.error("[ADMIN QUADRA UPDATE] Erro ao atualizar quadra:", error);
      return res.status(500).json({
        error: "Erro ao atualizar quadra (admin)",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Quadra não encontrada"
      });
    }

    const quadraComNome = {
      ...data,
      nome_dinamico: buildNomeQuadraDinamico(data)
    };

    return res.status(200).json(quadraComNome);
  } catch (err) {
    console.error("[ADMIN QUADRA UPDATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/quadras/:id (PUT)",
      detail: err.message
    });
  }
});


// =========================================
// 11.y Financeiro – Admin & Gestor (overview)
// =========================================

// Helper interno: agrupa pagamentos por dia (AAAA-MM-DD)
function groupByDay(items, dateField) {
  const map = new Map();
  for (const item of items) {
    const raw = item[dateField];
    if (!raw) continue;
    const dia = String(raw).slice(0, 10); // assume ISO / 'AAAA-MM-DD'
    if (!map.has(dia)) {
      map.set(dia, {
        dia,
        total_bruto: 0,
        taxa_plataforma: 0,
        valor_liquido: 0,
        qtd_pagamentos: 0
      });
    }
    const row = map.get(dia);
    const bruto = Number(item.valor_total || 0);
    const taxa = Number(item.taxa_plataforma || 0);
    const liquido = Number(item.valor_liquido_gestor || 0);
    row.total_bruto += bruto;
    row.taxa_plataforma += taxa;
    row.valor_liquido += liquido;
    row.qtd_pagamentos += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.dia.localeCompare(b.dia));
}

// -----------------------------------------
// Helper principal: overview financeiro (base)
// - por padrão, considera SOMENTE PIX (meio_pagamento="pix")
// - e aplica filtro de status via query (?status=paid|cancelled)
// -----------------------------------------
async function buildFinanceiroOverviewBase(params) {
  const { from, to, status, gestorId, quadraId, meio_pagamento } = params || {};

  // Datas padrão: últimos 7 dias
  const hoje = new Date();
  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(hoje.getDate() - 6);

  const fromStr =
    typeof from === "string" && from.length >= 10
      ? from.slice(0, 10)
      : seteDiasAtras.toISOString().slice(0, 10);

  const toStr =
    typeof to === "string" && to.length >= 10
      ? to.slice(0, 10)
      : hoje.toISOString().slice(0, 10);

  // Janela em created_at (pagamentos)
  const fromDateTime = `${fromStr}T00:00:00`;
  const toDateTime = `${toStr}T23:59:59`;

  // ✅ default: pix
  const meio = String(meio_pagamento || "pix").toLowerCase().trim();

  // 1) Busca pagamentos no período
  const { data: pagamentos, error: errPag } = await supabase
    .from("pagamentos")
    .select("*")
    .gte("created_at", fromDateTime)
    .lte("created_at", toDateTime);

  if (errPag) {
    console.error("[FINANCEIRO] Erro ao buscar pagamentos:", errPag);
    throw errPag;
  }

  let pagamentosList = pagamentos || [];

  // ✅ filtra por meio de pagamento (pix por padrão)
  // (aceita vazio/nulo como pix, pra não quebrar dados antigos)
  pagamentosList = pagamentosList.filter((p) => {
    const mp = String(p.meio_pagamento || "").toLowerCase().trim();
    if (!mp) return meio === "pix";
    return mp === meio;
  });

  // ✅ aplica filtro por status (paid/cancelled) antes de calcular tudo
  pagamentosList = filtrarPagamentosPorStatus(pagamentosList, status);

  if (pagamentosList.length === 0) {
    return {
      period: { from: fromStr, to: toStr },
      filtros: {
        gestorId: gestorId || null,
        quadraId: quadraId || null,
        status: status || null,
        meio_pagamento: meio
      },
      kpis: {
        qtd_pagamentos: 0,
        receita_bruta: 0,
        taxa_plataforma: 0,
        valor_liquido: 0
      },
      por_dia: { labels: [], receita_bruta: [], valor_liquido: [] },
      por_quadra: [],
      ultimos_pagamentos: []
    };
  }

  // 2) Busca reservas vinculadas a esses pagamentos
  const reservaIds = Array.from(
    new Set(
      pagamentosList
        .map((p) => p.reserva_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  let reservasList = [];
  if (reservaIds.length > 0) {
    const { data: reservas, error: errRes } = await supabase
      .from("reservas")
      .select(
        `
        id,
        data,
        hora,
        preco_total,
        status,
        quadra_id,
        user_cpf,
        phone
      `
      )
      .in("id", reservaIds);

    if (errRes) {
      console.error("[FINANCEIRO] Erro ao buscar reservas:", errRes);
      throw errRes;
    }
    reservasList = reservas || [];
  }

  const reservasMap = new Map();
  for (const r of reservasList) reservasMap.set(r.id, r);

  // 3) Busca quadras dessas reservas
  const quadraIds = Array.from(
    new Set(
      reservasList
        .map((r) => r.quadra_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  let quadrasList = [];
  if (quadraIds.length > 0) {
    const { data: quadras, error: errQ } = await supabase
      .from("quadras")
      .select(
        `
        id,
        tipo,
        material,
        modalidade,
        gestor_id
      `
      )
      .in("id", quadraIds);

    if (errQ) {
      console.error("[FINANCEIRO] Erro ao buscar quadras:", errQ);
      throw errQ;
    }
    quadrasList = quadras || [];
  }

  const quadrasMap = new Map();
  for (const q of quadrasList) quadrasMap.set(q.id, q);

  // 4) Aplica filtros de gestor/quadra
  let filtered = pagamentosList;

  if (gestorId || quadraId) {
    filtered = pagamentosList.filter((p) => {
      const reserva = reservasMap.get(p.reserva_id);
      if (!reserva) return false;
      const quadra = quadrasMap.get(reserva.quadra_id);
      if (!quadra) return false;

      if (gestorId && quadra.gestor_id !== gestorId) return false;
      if (quadraId && reserva.quadra_id !== quadraId) return false;
      return true;
    });
  }

  // 5) KPIs gerais
  let receitaBruta = 0;
  let taxaPlataforma = 0;
  let valorLiquido = 0;

  for (const p of filtered) {
    receitaBruta += Number(p.valor_total || 0);
    taxaPlataforma += Number(p.taxa_plataforma || 0);
    valorLiquido += Number(p.valor_liquido_gestor || 0);
  }

  // 6) Agrupamento por dia (created_at)
  const porDiaArray = groupByDay(filtered, "created_at");
  const labels = porDiaArray.map((d) => d.dia);
  const valoresBrutos = porDiaArray.map((d) => d.total_bruto);
  const valoresLiquidos = porDiaArray.map((d) => d.valor_liquido);

  // 7) Agrupamento por quadra
  const porQuadraMap = new Map();

  for (const p of filtered) {
    const reserva = reservasMap.get(p.reserva_id);
    if (!reserva) continue;
    const quadra = quadrasMap.get(reserva.quadra_id);
    if (!quadra) continue;

    const key = quadra.id;
    if (!porQuadraMap.has(key)) {
      porQuadraMap.set(key, {
        quadra_id: quadra.id,
        quadra_nome: buildNomeQuadraDinamico(quadra),
        gestor_id: quadra.gestor_id,
        qtd_pagamentos: 0,
        receita_bruta: 0,
        taxa_plataforma: 0,
        valor_liquido: 0
      });
    }

    const row = porQuadraMap.get(key);
    row.qtd_pagamentos += 1;
    row.receita_bruta += Number(p.valor_total || 0);
    row.taxa_plataforma += Number(p.taxa_plataforma || 0);
    row.valor_liquido += Number(p.valor_liquido_gestor || 0);
  }

  const porQuadra = Array.from(porQuadraMap.values()).sort(
    (a, b) => b.receita_bruta - a.receita_bruta
  );

  // 8) Últimos pagamentos
  const ultimosPagamentos = filtered
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 20)
    .map((p) => {
      const reserva = reservasMap.get(p.reserva_id);
      const quadra = reserva ? quadrasMap.get(reserva.quadra_id) : null;
      return {
        pagamento_id: p.id,
        created_at: p.created_at,
        reserva_id: p.reserva_id,
        quadra_id: reserva ? reserva.quadra_id : null,
        quadra_nome: quadra ? buildNomeQuadraDinamico(quadra) : "QUADRA SEM DEFINIÇÃO",
        gestor_id: quadra ? quadra.gestor_id : null,
        data_reserva: reserva ? reserva.data : null,
        hora_reserva: reserva ? reserva.hora : null,
        valor_total: Number(p.valor_total || 0),
        taxa_plataforma: Number(p.taxa_plataforma || 0),
        valor_liquido_gestor: Number(p.valor_liquido_gestor || 0),
        status: p.status || null,
        meio_pagamento: p.meio_pagamento || null
      };
    });

  return {
    period: { from: fromStr, to: toStr },
    filtros: {
      gestorId: gestorId || null,
      quadraId: quadraId || null,
      status: status || null,
      meio_pagamento: meio
    },
    kpis: {
      qtd_pagamentos: filtered.length,
      receita_bruta: receitaBruta,
      taxa_plataforma: taxaPlataforma,
      valor_liquido: valorLiquido
    },
    por_dia: {
      labels,
      receita_bruta: valoresBrutos,
      valor_liquido: valoresLiquidos
    },
    por_quadra: porQuadra,
    ultimos_pagamentos: ultimosPagamentos
  };
}


// -----------------------------------------
// Rota: Financeiro Admin - overview
// -----------------------------------------
app.get(
  "/admin/financeiro-overview",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { from, to, gestorId, quadraId } = req.query;

    const overview = await buildFinanceiroOverviewBase({
      from,
      to,
      gestorId: gestorId || null,
      quadraId: quadraId || null
    });

    return res.status(200).json(overview);
  } catch (err) {
    console.error("[FINANCEIRO ADMIN] Erro em /admin/financeiro-overview:", err);
    return res.status(500).json({
      error: "Erro ao montar financeiro admin",
      detail: err.message
    });
  }
});

// -----------------------------------------
// Rota: Financeiro Gestor - overview
// Query: ?from=AAAA-MM-DD&to=AAAA-MM-DD&status=paid|cancelled
// -----------------------------------------
app.get(
  "/gestor/financeiro-overview",
  autenticarPainel,
  async (req, res) => {
    try {
      const { from, to, status } = req.query; // ✅ adiciona status
      const gestorId = req.user.id;

      if (!gestorId) {
        return res.status(400).json({
          error: "gestorId inválido em /gestor/financeiro-overview"
        });
      }

      const overview = await buildFinanceiroOverviewBase({
        from,
        to,
        status, // ✅ passa pro helper
        gestorId,
        quadraId: null
      });

      return res.status(200).json(overview);
    } catch (err) {
      console.error(
        "[FINANCEIRO GESTOR] Erro em /gestor/financeiro-overview:",
        err
      );
      return res.status(500).json({
        error: "Erro ao montar financeiro do gestor",
        detail: err.message
      });
    }
  }
);

// =========================================
// 11.z Repasses – Admin & Gestor
// =========================================

// ------------------------------
// Helpers de status "pago"
// ------------------------------
function isPagamentoPago(status) {
  const s = String(status || "").toLowerCase().trim();
  // seja tolerante com variações (depende de como você salva no webhook)
  return (
    s === "pago" ||
    s === "paid" ||
    s === "approved" ||
    s === "aprovado" ||
    s === "confirmado"
  );
}
function isPagamentoCancelado(status) {
  const s = String(status || "").toLowerCase().trim();
  return (
    s === "cancelled" ||
    s === "canceled" ||
    s === "cancelado" ||
    s === "cancelada"
  );
}

// status esperado da query: "paid" | "cancelled" | (vazio)
function filtrarPagamentosPorStatus(lista, statusQuery) {
  const st = String(statusQuery || "").toLowerCase().trim();
  if (!st) return lista;

  if (st === "paid") {
    return (lista || []).filter((p) => isPagamentoPago(p.status));
  }

  if (st === "cancelled" || st === "canceled" || st === "cancelado") {
    return (lista || []).filter(
      (p) => isPagamentoCancelado(p.status) && !isPagamentoPago(p.status)
    );
  }

  // Se vier qualquer outro valor, não filtra (pra não “sumir” tudo)
  return lista;
}


function normalizarYYYYMM(yyyyMm) {
  // aceita "2025-12" ou "2025-12-01"
  const raw = String(yyyyMm || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);
  return null;
}

function firstDayFromYYYYMM(yyyyMm) {
  const m = normalizarYYYYMM(yyyyMm);
  if (!m) return null;
  return `${m}-01`;
}

// ------------------------------
// Carrega pagamentos elegíveis (pago) por gestor e período,
// e que AINDA NÃO estejam em repasse nenhum.
// ------------------------------
async function buscarPagamentosElegiveisParaRepasse({
  gestorId,
  from,
  to
}) {
  if (!gestorId) throw new Error("gestorId é obrigatório");

  // Período padrão: mês atual (se não vier nada)
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, "0");
  const defaultFrom = `${yyyy}-${mm}-01`;

  const fromStr =
    typeof from === "string" && from.length >= 10 ? from.slice(0, 10) : defaultFrom;

  const toStr =
    typeof to === "string" && to.length >= 10
      ? to.slice(0, 10)
      : new Date(yyyy, hoje.getMonth() + 1, 0).toISOString().slice(0, 10); // último dia do mês

  const fromDateTime = `${fromStr}T00:00:00`;
  const toDateTime = `${toStr}T23:59:59`;

  // 1) Busca pagamentos no período
  const { data: pagamentos, error: errPag } = await supabase
    .from("pagamentos")
    .select("*")
    .gte("created_at", fromDateTime)
    .lte("created_at", toDateTime);

  if (errPag) throw errPag;

  const pagos = (pagamentos || []).filter((p) => isPagamentoPago(p.status));

  if (pagos.length === 0) {
    return { from: fromStr, to: toStr, pagamentos: [] };
  }

  // 2) Busca reservas dos pagamentos
  const reservaIds = Array.from(
    new Set(
      pagos
        .map((p) => p.reserva_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  const { data: reservas, error: errRes } = await supabase
    .from("reservas")
    .select("id, quadra_id, data, hora, user_cpf, phone, preco_total, status")
    .in("id", reservaIds);

  if (errRes) throw errRes;

  const reservasMap = new Map();
  for (const r of reservas || []) reservasMap.set(r.id, r);

  // 3) Busca quadras para filtrar por gestor
  const quadraIds = Array.from(
    new Set(
      (reservas || [])
        .map((r) => r.quadra_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );

  const { data: quadras, error: errQ } = await supabase
    .from("quadras")
    .select("id, tipo, material, modalidade, gestor_id")
    .in("id", quadraIds);

  if (errQ) throw errQ;

  const quadrasMap = new Map();
  for (const q of quadras || []) quadrasMap.set(q.id, q);

  // 4) Filtra pagamentos do gestor
  const doGestor = pagos.filter((p) => {
    const r = reservasMap.get(p.reserva_id);
    if (!r) return false;
    const q = quadrasMap.get(r.quadra_id);
    if (!q) return false;
    return String(q.gestor_id) === String(gestorId);
  });

  if (doGestor.length === 0) {
    return { from: fromStr, to: toStr, pagamentos: [] };
  }

  // 5) Remove pagamentos já vinculados a algum repasse
  const pagamentoIds = doGestor.map((p) => p.id);

  const { data: vinculos, error: errV } = await supabase
    .from("repasses_pagamentos")
    .select("pagamento_id")
    .in("pagamento_id", pagamentoIds);

  if (errV) throw errV;

  const jaVinculados = new Set((vinculos || []).map((v) => v.pagamento_id));
  const elegiveis = doGestor.filter((p) => !jaVinculados.has(p.id));

  // 6) Enriquecimento básico (para detalhe da listagem)
  const pagamentosDetalhados = elegiveis.map((p) => {
    const r = reservasMap.get(p.reserva_id);
    const q = r ? quadrasMap.get(r.quadra_id) : null;
    return {
      ...p,
      reserva: r || null,
      quadra: q
        ? {
            id: q.id,
            tipo: q.tipo,
            material: q.material,
            modalidade: q.modalidade,
            gestor_id: q.gestor_id
          }
        : null
    };
  });

  return { from: fromStr, to: toStr, pagamentos: pagamentosDetalhados };
}

// =====================================================
// ADMIN: GERAR REPASSE (cria repasse + vincula pagamentos)
// POST /admin/repasses/gerar
// body: { gestorId, from?, to?, competencia? ("YYYY-MM") }
// =====================================================
app.post(
  "/admin/repasses/gerar",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
    try {
      const { gestorId, from, to, competencia } = req.body || {};

      if (!gestorId) {
        return res.status(400).json({ error: "gestorId é obrigatório" });
      }

      const periodo = await buscarPagamentosElegiveisParaRepasse({
        gestorId,
        from,
        to
      });

      const pagamentos = periodo.pagamentos || [];

      if (pagamentos.length === 0) {
        return res.status(200).json({
          ok: true,
          message: "Nenhum pagamento elegível para repasse neste período.",
          periodo: { from: periodo.from, to: periodo.to },
          repasse: null
        });
      }

      // Totais calculados a partir de pagamentos (schema: bruto/taxa/liquido)
let totalBruto = 0;
let totalTaxa = 0;
let totalLiquido = 0;

for (const p of pagamentos) {
  totalBruto += Number(p.valor_total || 0);
  totalTaxa += Number(p.taxa_plataforma || 0);
  totalLiquido += Number(p.valor_liquido_gestor || 0);
}

const competenciaYYYYMM = normalizarYYYYMM(competencia) || periodo.from.slice(0, 7);
const competenciaData = firstDayFromYYYYMM(competenciaYYYYMM);

// 1) cria repasse
const { data: repasseCriado, error: errRep } = await supabase
  .from("repasses")
  .insert([
    {
      gestor_id: gestorId,
      competencia: competenciaData, // date (YYYY-MM-01)
      valor_total_bruto: round2(totalBruto),
      valor_total_taxa: round2(totalTaxa),
      valor_total_liquido: round2(totalLiquido),
      status: "pendente"
    }
  ])
  .select("*")
  .single();

if (errRep) {
  console.error("[REPASSE] Erro ao criar repasse:", errRep);
  throw errRep;
}


      // 2) vincula pagamentos ao repasse
      const vinculosInsert = pagamentos.map((p) => ({
        repasse_id: repasseCriado.id,
        pagamento_id: p.id
      }));

      const { error: errLink } = await supabase
        .from("repasses_pagamentos")
        .insert(vinculosInsert);

      if (errLink) {
        console.error("[REPASSE] Erro ao vincular pagamentos:", errLink);
        throw errLink;
      }

      return res.status(201).json({
        ok: true,
        periodo: { from: periodo.from, to: periodo.to },
        repasse: repasseCriado,
        qtd_pagamentos: pagamentos.length
      });
    } catch (err) {
      console.error("[ADMIN REPASSES] Erro em /admin/repasses/gerar:", err);
      return res.status(500).json({
        error: "Erro ao gerar repasse",
        detail: err.message
      });
    }
  }
);

// =========================================
// ADMIN: LISTAR REPASSES
// GET /admin/repasses?gestorId=&status=&competencia=YYYY-MM
// =========================================
app.get(
  "/admin/repasses",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
    try {
      const { gestorId, status, competencia } = req.query || {};

      let query = supabase
        .from("repasses")
        .select("*")
        .order("created_at", { ascending: false });

      if (gestorId) query = query.eq("gestor_id", gestorId);
      if (status) query = query.eq("status", status);

      const comp = normalizarYYYYMM(competencia);
      if (comp) {
        query = query.gte("competencia", `${comp}-01`).lte("competencia", `${comp}-31`);
      }

      const { data, error } = await query;

      if (error) throw error;

      return res.status(200).json({ repasses: data || [] });
    } catch (err) {
      console.error("[ADMIN REPASSES] Erro em /admin/repasses:", err);
      return res.status(500).json({
        error: "Erro ao listar repasses",
        detail: err.message
      });
    }
  }
);

// =========================================
// ADMIN: DETALHE DO REPASSE (com pagamentos)
// GET /admin/repasses/:id
// =========================================
app.get(
  "/admin/repasses/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
    try {
      const repasseId = req.params.id;

      const { data: repasse, error: errR } = await supabase
        .from("repasses")
        .select("*")
        .eq("id", repasseId)
        .single();

      if (errR) throw errR;

      const { data: links, error: errL } = await supabase
        .from("repasses_pagamentos")
        .select("pagamento_id")
        .eq("repasse_id", repasseId);

      if (errL) throw errL;

      const pagamentoIds = (links || []).map((l) => l.pagamento_id);

      let pagamentos = [];
      if (pagamentoIds.length > 0) {
        const { data: pags, error: errP } = await supabase
          .from("pagamentos")
          .select("*")
          .in("id", pagamentoIds)
          .order("created_at", { ascending: false });

        if (errP) throw errP;
        pagamentos = pags || [];
      }

      return res.status(200).json({ repasse, pagamentos });
    } catch (err) {
      console.error("[ADMIN REPASSES] Erro em /admin/repasses/:id:", err);
      return res.status(500).json({
        error: "Erro ao buscar detalhe do repasse",
        detail: err.message
      });
    }
  }
);

// =========================================
// ADMIN: MARCAR REPASSE COMO PAGO
// PUT /admin/repasses/:id/pagar
// body: { data_pagamento?: "YYYY-MM-DD", observacao?: string }
// =========================================
app.put(
  "/admin/repasses/:id/pagar",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
    try {
      const repasseId = req.params.id;
      const { data_pagamento, observacao } = req.body || {};

      const payload = {
        status: "pago",
        data_pagamento: data_pagamento ? String(data_pagamento).slice(0, 10) : new Date().toISOString().slice(0, 10),
        ...(typeof observacao === "string" ? { observacao } : {})
      };

      const { data, error } = await supabase
        .from("repasses")
        .update(payload)
        .eq("id", repasseId)
        .select("*")
        .single();

      if (error) throw error;

      return res.status(200).json({ ok: true, repasse: data });
    } catch (err) {
      console.error("[ADMIN REPASSES] Erro em /admin/repasses/:id/pagar:", err);
      return res.status(500).json({
        error: "Erro ao marcar repasse como pago",
        detail: err.message
      });
    }
  }
);

// =========================================
// GESTOR: LISTAR REPASSES DO PRÓPRIO GESTOR
// GET /gestor/repasses
// =========================================
app.get(
  "/gestor/repasses",
  autenticarPainel,
  async (req, res) => {
    try {
      const gestorId = req.user.id;

      const { data, error } = await supabase
        .from("repasses")
        .select("*")
        .eq("gestor_id", gestorId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return res.status(200).json({ repasses: data || [] });
    } catch (err) {
      console.error("[GESTOR REPASSES] Erro em /gestor/repasses:", err);
      return res.status(500).json({
        error: "Erro ao listar repasses do gestor",
        detail: err.message
      });
    }
  }
);

// =========================================
// GESTOR: DETALHE DO REPASSE (com pagamentos)
// GET /gestor/repasses/:id
// =========================================
app.get(
  "/gestor/repasses/:id",
  autenticarPainel,
  async (req, res) => {
    try {
      const gestorId = req.user.id;
      const repasseId = req.params.id;

      const { data: repasse, error: errR } = await supabase
        .from("repasses")
        .select("*")
        .eq("id", repasseId)
        .single();

      if (errR) throw errR;

      if (String(repasse.gestor_id) !== String(gestorId)) {
        return res.status(403).json({ error: "Acesso negado a este repasse." });
      }

      const { data: links, error: errL } = await supabase
        .from("repasses_pagamentos")
        .select("pagamento_id")
        .eq("repasse_id", repasseId);

      if (errL) throw errL;

      const pagamentoIds = (links || []).map((l) => l.pagamento_id);

      let pagamentos = [];
      if (pagamentoIds.length > 0) {
        const { data: pags, error: errP } = await supabase
          .from("pagamentos")
          .select("*")
          .in("id", pagamentoIds)
          .order("created_at", { ascending: false });

        if (errP) throw errP;
        pagamentos = pags || [];
      }

      return res.status(200).json({ repasse, pagamentos });
    } catch (err) {
      console.error("[GESTOR REPASSES] Erro em /gestor/repasses/:id:", err);
      return res.status(500).json({
        error: "Erro ao buscar detalhe do repasse",
        detail: err.message
      });
    }
  }
);

// =========================================
// 11.z CMS de Textos – WhatsApp & Flow
// =========================================

// -----------------------------------------
// Helpers para montar filtros de mensagens
// -----------------------------------------
function buildMensagensFilter(query) {
  const { contexto, chave, gestorId, quadraId } = query || {};
  const filter = {};

  if (contexto) filter.contexto = contexto;
  if (chave) filter.chave = chave;
  if (gestorId) filter.gestor_id = gestorId;
  if (quadraId) filter.quadra_id = quadraId;

  return filter;
}

// Pequeno helper para aplicar filtros em uma query do Supabase
function applyFilters(query, filter) {
  let q = query;
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== "") {
      q = q.eq(key, value);
    }
  }
  return q;
}

// =========================================
// 11.z.1 MENSAGENS WHATSAPP (Admin & Gestor)
// =========================================

// ---------- ADMIN: listar mensagens ----------
app.get(
  "/admin/mensagens-whatsapp",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const filter = buildMensagensFilter(req.query);

    let query = supabase
      .from("mensagens_whatsapp")
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .order("chave", { ascending: true });

    query = applyFilters(query, filter);

    const { data, error } = await query;

    if (error) {
      console.error("[ADMIN MSG WHATS] Erro ao listar mensagens:", error);
      return res.status(500).json({
        error: "Erro ao listar mensagens_whatsapp (admin)",
        detail: error.message
      });
    }

    return res.status(200).json({ mensagens: data || [] });
  } catch (err) {
    console.error("[ADMIN MSG WHATS] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/mensagens-whatsapp",
      detail: err.message
    });
  }
});

// ---------- ADMIN: obter 1 mensagem ----------
app.get(
  "/admin/mensagens-whatsapp/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("mensagens_whatsapp")
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .eq("id", id)
      .single();

    if (error) {
      console.error("[ADMIN MSG WHATS DETALHE] Erro ao buscar mensagem:", error);
      return res.status(500).json({
        error: "Erro ao buscar mensagem_whatsapp (admin)",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({ error: "Mensagem não encontrada" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[ADMIN MSG WHATS DETALHE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/mensagens-whatsapp/:id",
      detail: err.message
    });
  }
});

// ---------- ADMIN: criar mensagem ----------
app.post(
  "/admin/mensagens-whatsapp",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { chave, contexto, conteudo, gestor_id, quadra_id } = req.body || {};

    if (!chave || !contexto || !conteudo) {
      return res.status(400).json({
        error:
          "Campos obrigatórios: chave, contexto e conteudo para criar mensagem_whatsapp"
      });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("mensagens_whatsapp")
      .insert([
        {
          chave,
          contexto,
          conteudo,
          gestor_id: gestor_id || null,
          quadra_id: quadra_id || null,
          updated_at: now
        }
      ])
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .single();

    if (error) {
      console.error("[ADMIN MSG WHATS CREATE] Erro ao criar mensagem:", error);
      return res.status(500).json({
        error: "Erro ao criar mensagem_whatsapp (admin)",
        detail: error.message
      });
    }

    return res.status(201).json(data);
  } catch (err) {
    console.error("[ADMIN MSG WHATS CREATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em POST /admin/mensagens-whatsapp",
      detail: err.message
    });
  }
});

// ---------- ADMIN: editar mensagem ----------
app.put(
  "/admin/mensagens-whatsapp/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { id } = req.params;
    const { chave, contexto, conteudo, gestor_id, quadra_id } = req.body || {};

    const update = {};
    if (chave !== undefined) update.chave = chave;
    if (contexto !== undefined) update.contexto = contexto;
    if (conteudo !== undefined) update.conteudo = conteudo;
    if (gestor_id !== undefined) update.gestor_id = gestor_id;
    if (quadra_id !== undefined) update.quadra_id = quadra_id;
    update.updated_at = new Date().toISOString();

    if (Object.keys(update).length === 1 && update.updated_at) {
      return res.status(400).json({
        error:
          "Nenhum campo (chave/contexto/conteudo/gestor_id/quadra_id) foi enviado para atualização"
      });
    }

    const { data, error } = await supabase
      .from("mensagens_whatsapp")
      .update(update)
      .eq("id", id)
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .single();

    if (error) {
      console.error("[ADMIN MSG WHATS UPDATE] Erro ao atualizar mensagem:", error);
      return res.status(500).json({
        error: "Erro ao atualizar mensagem_whatsapp (admin)",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({ error: "Mensagem não encontrada" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[ADMIN MSG WHATS UPDATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em PUT /admin/mensagens-whatsapp/:id",
      detail: err.message
    });
  }
});

// ---------- GESTOR: listar mensagens (somente dele) ----------
app.get("/gestor/mensagens-whatsapp", autenticarPainel, async (req, res) => {
  try {
    const { contexto, chave, quadraId } = req.query;
    const gestorId = req.user.id;

    if (!gestorId) {
      return res.status(400).json({
        error:
          "Parâmetro gestorId é obrigatório em /gestor/mensagens-whatsapp"
      });
    }

    const filter = buildMensagensFilter({
      contexto,
      chave,
      gestorId,
      quadraId
    });

    let query = supabase
      .from("mensagens_whatsapp")
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .eq("gestor_id", gestorId)
      .order("chave", { ascending: true });

    query = applyFilters(query, filter);

    const { data, error } = await query;

    if (error) {
      console.error("[GESTOR MSG WHATS] Erro ao listar mensagens:", error);
      return res.status(500).json({
        error: "Erro ao listar mensagens_whatsapp do gestor",
        detail: error.message
      });
    }

    return res.status(200).json({ mensagens: data || [] });
  } catch (err) {
    console.error("[GESTOR MSG WHATS] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /gestor/mensagens-whatsapp",
      detail: err.message
    });
  }
});

// ---------- GESTOR: editar mensagem (apenas dele) ----------
app.put(
  "/gestor/mensagens-whatsapp/:id",
  autenticarPainel,
  async (req, res) => {
  try {
    const gestorId = req.user.id;

    const { id } = req.params;

    if (!gestorId) {
      return res.status(400).json({
        error:
          "Parâmetro gestorId é obrigatório em /gestor/mensagens-whatsapp/:id (PUT)"
      });
    }

    const { conteudo } = req.body || {};

    if (conteudo === undefined) {
      return res.status(400).json({
        error: "Campo conteudo é obrigatório para o gestor editar a mensagem"
      });
    }

    const update = {
      conteudo,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("mensagens_whatsapp")
      .update(update)
      .eq("id", id)
      .eq("gestor_id", gestorId)
      .select(
        `
        id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo,
        updated_at
      `
      )
      .single();

    if (error) {
      console.error(
        "[GESTOR MSG WHATS UPDATE] Erro ao atualizar mensagem:",
        error
      );
      return res.status(500).json({
        error: "Erro ao atualizar mensagem_whatsapp do gestor",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Mensagem não encontrada para este gestor"
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[GESTOR MSG WHATS UPDATE] Erro geral:", err);
    return res.status(500).json({
      error:
        "Erro inesperado em PUT /gestor/mensagens-whatsapp/:id",
      detail: err.message
    });
  }
});

// =========================================
// 11.z.2 FLOW_TEXTOS (Admin & Gestor)
// =========================================

// ---------- ADMIN: listar textos de Flow ----------
app.get(
  "/admin/flow-textos",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { screen_id, contexto, chave, gestorId, quadraId } = req.query;

    let query = supabase
      .from("flow_textos")
      .select(
        `
        id,
        screen_id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo
      `
      )
      .order("screen_id", { ascending: true })
      .order("chave", { ascending: true });

    if (screen_id) query = query.eq("screen_id", screen_id);
    if (contexto) query = query.eq("contexto", contexto);
    if (chave) query = query.eq("chave", chave);
    if (gestorId) query = query.eq("gestor_id", gestorId);
    if (quadraId) query = query.eq("quadra_id", quadraId);

    const { data, error } = await query;

    if (error) {
      console.error("[ADMIN FLOW TXT] Erro ao listar flow_textos:", error);
      return res.status(500).json({
        error: "Erro ao listar flow_textos (admin)",
        detail: error.message
      });
    }

    return res.status(200).json({ textos: data || [] });
  } catch (err) {
    console.error("[ADMIN FLOW TXT] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /admin/flow-textos",
      detail: err.message
    });
  }
});

// ---------- ADMIN: criar texto de Flow ----------
app.post(
  "/admin/flow-textos",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const {
      screen_id,
      chave,
      contexto,
      conteudo,
      gestor_id,
      quadra_id
    } = req.body || {};

    if (!screen_id || !chave || !contexto || !conteudo) {
      return res.status(400).json({
        error:
          "Campos obrigatórios: screen_id, chave, contexto e conteudo para criar flow_textos"
      });
    }

    const { data, error } = await supabase
      .from("flow_textos")
      .insert([
        {
          screen_id,
          chave,
          contexto,
          conteudo,
          gestor_id: gestor_id || null,
          quadra_id: quadra_id || null
        }
      ])
      .select(
        `
        id,
        screen_id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo
      `
      )
      .single();

    if (error) {
      console.error("[ADMIN FLOW TXT CREATE] Erro ao criar flow_texto:", error);
      return res.status(500).json({
        error: "Erro ao criar flow_texto (admin)",
        detail: error.message
      });
    }

    return res.status(201).json(data);
  } catch (err) {
    console.error("[ADMIN FLOW TXT CREATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em POST /admin/flow-textos",
      detail: err.message
    });
  }
});

// ---------- ADMIN: editar texto de Flow ----------
app.put(
  "/admin/flow-textos/:id",
  autenticarPainel,
  garantirAdmin,
  async (req, res) => {
  try {
    const { id } = req.params;
    const {
      screen_id,
      chave,
      contexto,
      conteudo,
      gestor_id,
      quadra_id
    } = req.body || {};

    const update = {};
    if (screen_id !== undefined) update.screen_id = screen_id;
    if (chave !== undefined) update.chave = chave;
    if (contexto !== undefined) update.contexto = contexto;
    if (conteudo !== undefined) update.conteudo = conteudo;
    if (gestor_id !== undefined) update.gestor_id = gestor_id;
    if (quadra_id !== undefined) update.quadra_id = quadra_id;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error:
          "Nenhum campo válido foi enviado para atualização de flow_textos"
      });
    }

    const { data, error } = await supabase
      .from("flow_textos")
      .update(update)
      .eq("id", id)
      .select(
        `
        id,
        screen_id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo
      `
      )
      .single();

    if (error) {
      console.error("[ADMIN FLOW TXT UPDATE] Erro ao atualizar flow_texto:", error);
      return res.status(500).json({
        error: "Erro ao atualizar flow_texto (admin)",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({ error: "flow_texto não encontrado" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[ADMIN FLOW TXT UPDATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em PUT /admin/flow-textos/:id",
      detail: err.message
    });
  }
});

// ---------- GESTOR: listar textos de Flow (somente dele) ----------
app.get("/gestor/flow-textos", autenticarPainel, async (req, res) => {
  try {
    const { screen_id, contexto, chave, quadraId } = req.query;
    const gestorId = req.user.id;


    if (!gestorId) {
      return res.status(400).json({
        error: "Parâmetro gestorId é obrigatório em /gestor/flow-textos"
      });
    }

    let query = supabase
      .from("flow_textos")
      .select(
        `
        id,
        screen_id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo
      `
      )
      .eq("gestor_id", gestorId)
      .order("screen_id", { ascending: true })
      .order("chave", { ascending: true });

    if (screen_id) query = query.eq("screen_id", screen_id);
    if (contexto) query = query.eq("contexto", contexto);
    if (chave) query = query.eq("chave", chave);
    if (quadraId) query = query.eq("quadra_id", quadraId);

    const { data, error } = await query;

    if (error) {
      console.error("[GESTOR FLOW TXT] Erro ao listar flow_textos:", error);
      return res.status(500).json({
        error: "Erro ao listar flow_textos do gestor",
        detail: error.message
      });
    }

    return res.status(200).json({ textos: data || [] });
  } catch (err) {
    console.error("[GESTOR FLOW TXT] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em /gestor/flow-textos",
      detail: err.message
    });
  }
});

// ---------- GESTOR: editar texto de Flow (apenas dele) ----------
app.put("/gestor/flow-textos/:id", autenticarPainel, async (req, res) => {
  try {
    const gestorId = req.user.id;

    const { id } = req.params;

    if (!gestorId) {
      return res.status(400).json({
        error:
          "Parâmetro gestorId é obrigatório em /gestor/flow-textos/:id (PUT)"
      });
    }

    const { conteudo } = req.body || {};

    if (conteudo === undefined) {
      return res.status(400).json({
        error: "Campo conteudo é obrigatório para o gestor editar o texto"
      });
    }

    const update = { conteudo };

    const { data, error } = await supabase
      .from("flow_textos")
      .update(update)
      .eq("id", id)
      .eq("gestor_id", gestorId)
      .select(
        `
        id,
        screen_id,
        chave,
        contexto,
        gestor_id,
        quadra_id,
        conteudo
      `
      )
      .single();

    if (error) {
      console.error(
        "[GESTOR FLOW TXT UPDATE] Erro ao atualizar flow_texto:",
        error
      );
      return res.status(500).json({
        error: "Erro ao atualizar flow_texto do gestor",
        detail: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "flow_texto não encontrado para este gestor"
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("[GESTOR FLOW TXT UPDATE] Erro geral:", err);
    return res.status(500).json({
      error: "Erro inesperado em PUT /gestor/flow-textos/:id",
      detail: err.message
    });
  }
});
// ==========================================================
// CRON JOB: cancelar reservas pendentes com mais de 30 minutos
// ==========================================================
cron.schedule("* * * * *", async () => {
  try {
    const agora = new Date();
    const limiteISO = new Date(
      agora.getTime() - 30 * 60 * 1000 // 30 minutos atrás
    ).toISOString();

    // Atualiza todas as reservas pendentes criadas antes do limite
    const { data, error } = await supabase
      .from("reservas")
.update({
  status: "canceled",
  updated_at: new Date().toISOString(),
})
.in("status", ["pending", "pendente"]) // compat legado (se existir)
.lt("created_at", limiteISO)

      .select("id");

    if (error) {
      console.error(
        "[CRON RESERVAS] Erro ao cancelar reservas expiradas:",
        error
      );
      return;
    }

    if (data && data.length > 0) {
      console.log(
        `[CRON RESERVAS] Reservas expiradas canceladas: ${data.length}`,
        data.map((r) => r.id)
      );
    }
  } catch (err) {
    console.error(
      "[CRON RESERVAS] Erro inesperado no job de expiração:",
      err
    );
  }
});
// ROTA DE DIAGNÓSTICO DO CRON (Acesse pelo navegador: /teste-cron)
app.get("/teste-cron", async (req, res) => {
  const agora = new Date();
  const limiteISO = new Date(agora.getTime() - 30 * 60 * 1000).toISOString();

  console.log("--- DEBUG CRON ---");
  console.log("Hora Agora (Server):", agora.toISOString());
  console.log("Hora Limite (30min atrás):", limiteISO);

  // Tenta buscar o que seria cancelado (SELECT)
  const { data: candidatos, error: errSelect } = await supabase
    .from("reservas")
    .select("id, created_at, status")
    .eq("status", "pending")
    .lt("created_at", limiteISO);

  if (errSelect) {
    return res.json({ erro: "Erro ao consultar", detalhe: errSelect });
  }

  // Tenta efetivar o cancelamento (UPDATE)
  const { data: atualizados, error: errUpdate } = await supabase
    .from("reservas")
.update({
  status: "canceled",
  updated_at: new Date().toISOString(),
})
.in("status", ["pending", "pendente"])
.lt("created_at", limiteISO)
    .select();

  if (errUpdate) {
    return res.json({ 
      erro: "Erro ao atualizar (Provável RLS)", 
      detalhe: errUpdate,
      candidatos_encontrados: candidates 
    });
  }

  res.json({
    status: "Sucesso",
    candidatos_a_apagar: candidatos,
    registros_atualizados: atualizados,
    msg: atualizados.length === 0 ? "Nenhuma reserva antiga encontrada para cancelar." : "Limpeza feita!"
  });
});
// -----------------------------------------
// 12. Sobe o servidor
// -----------------------------------------
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`VaiTerPlay rodando na porta ${port}`);
  console.log(
    "Dica: Teste com 'Oi' no WhatsApp. CPF nos agendamentos ok! Adicione coluna 'phone' em reservas."
  );
});
// ===================================================
// 🚀 FIX NODE 22 — executar async inicialização corretamente
// ===================================================
async function startServer() {
  // Nada aqui dentro ainda — só inicialização quando necessário
}

startServer().catch(err => {
  console.error("[INIT ERROR]", err);
});
