import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultPeriodo30() {
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - 30);
  return { inicio: toISODate(inicio), fim: toISODate(fim) };
}

function formatBRL(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function AdminFinanceiroPage() {
  const def = useMemo(() => defaultPeriodo30(), []);
  const [from, setFrom] = useState(def.inicio);
  const [to, setTo] = useState(def.fim);

  const [gestores, setGestores] = useState([]);
  const [gestorId, setGestorId] = useState(""); // opcional

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");

  const [overview, setOverview] = useState(null);
  const [resumo, setResumo] = useState(null); // ✅ novo: /admin/financeiro/resumo

  async function carregarGestores() {
    try {
      const { data } = await api.get("/admin/gestores-resumo");
      setGestores(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn("[ADMIN/FINANCEIRO] falha ao carregar gestores:", e);
      setGestores([]);
    }
  }

  async function carregarTudo() {
    setLoading(true);
    setErro("");

    try {
      // ✅ busca em paralelo:
      // - overview (kpis / por_quadra / ultimos_pagamentos)
      // - resumo (pendentes de repasse / repasses pendentes / repasses pagos)
      const [rOverview, rResumo] = await Promise.all([
        api.get("/admin/financeiro-overview", {
          params: {
            from,
            to,
            gestorId: gestorId || undefined
          }
        }),
        api.get("/admin/financeiro/resumo", {
          params: {
            from,
            to,
            gestorId: gestorId || undefined
          }
        })
      ]);

      setOverview(rOverview.data || null);
      setResumo(rResumo.data || null);
    } catch (e) {
      console.error("[ADMIN/FINANCEIRO] erro ao carregar:", e);
      setErro(
        e?.response?.data?.error ||
          "Erro ao carregar financeiro do admin. Verifique o backend."
      );
      setOverview(null);
      setResumo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregarGestores();
    carregarTudo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kpis = overview?.kpis || {};
  const ultimos = Array.isArray(overview?.ultimos_pagamentos)
    ? overview.ultimos_pagamentos
    : [];
  const porQuadra = Array.isArray(overview?.por_quadra) ? overview.por_quadra : [];

  // ✅ novos cards do resumo
  const pendentesRepasse = resumo?.pendentesRepasse || {};
  const repassesPendentes = resumo?.repassesPendentes || {};
  const repassesPagos = resumo?.repassesPagos || {};

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
        Financeiro (Admin)
      </h1>
      <p style={{ marginTop: 6, opacity: 0.8 }}>
        Visão geral por período. Você pode filtrar por Gestor.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "160px 160px 260px 1fr",
          gap: 12,
          alignItems: "end",
          padding: 12,
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.10)",
          marginBottom: 12
        }}
      >
        <div>
          <label style={labelSmall}>Início</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelSmall}>Fim</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelSmall}>Gestor (opcional)</label>
          <select
            value={gestorId}
            onChange={(e) => setGestorId(e.target.value)}
            style={inputStyle}
          >
            <option value="">Todos</option>
            {gestores.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome} ({g.email})
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={btnPrimary} onClick={carregarTudo}>
            {loading ? "Carregando..." : "Aplicar"}
          </button>
          <button
            style={btn}
            onClick={() => {
              const d = defaultPeriodo30();
              setFrom(d.inicio);
              setTo(d.fim);
              setGestorId("");
              setTimeout(() => carregarTudo(), 0);
            }}
          >
            Últimos 30 dias
          </button>
        </div>
      </div>

      {erro ? <div style={errorBox}>{erro}</div> : null}

      {/* ✅ KPI + RESUMO (7 cards) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 12
        }}
      >
        <Card label="Qtd. Pagamentos" value={loading ? "..." : (kpis.qtd_pagamentos ?? 0)} />
        <Card label="Receita Bruta" value={loading ? "..." : formatBRL(kpis.receita_bruta)} />
        <Card label="Taxa Plataforma" value={loading ? "..." : formatBRL(kpis.taxa_plataforma)} />
        <Card label="Líquido (Gestores)" value={loading ? "..." : formatBRL(kpis.valor_liquido)} />

        {/* ✅ novos cards */}
        <Card
          label="Pendentes de repasse (A pagar)"
          value={
            loading
              ? "..."
              : `${pendentesRepasse.totalQtd ?? 0} • ${formatBRL(pendentesRepasse.totalValor ?? 0)}`
          }
          hint="Pagamentos paid ainda não vinculados a um repasse"
        />
        <Card
          label="Repasses pendentes"
          value={
            loading
              ? "..."
              : `${repassesPendentes.totalQtd ?? 0} • ${formatBRL(repassesPendentes.totalValor ?? 0)}`
          }
          hint="Repasses criados e ainda pendentes"
        />
        <Card
          label="Repasses pagos"
          value={
            loading
              ? "..."
              : `${repassesPagos.totalQtd ?? 0} • ${formatBRL(repassesPagos.totalValor ?? 0)}`
          }
          hint="Repasses concluídos no período"
        />
      </div>

      {/* POR QUADRA */}
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Por Quadra (Top)</h2>

        <div style={{ marginTop: 10 }}>
          {porQuadra.length === 0 ? (
            <div style={{ opacity: 0.75, padding: 10 }}>Sem dados no período.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={rowHeadQuadra}>
                <div>Quadra</div>
                <div style={{ textAlign: "right" }}>Qtd</div>
                <div style={{ textAlign: "right" }}>Bruto</div>
                <div style={{ textAlign: "right" }}>Taxa</div>
                <div style={{ textAlign: "right" }}>Líquido</div>
              </div>

              {porQuadra.slice(0, 20).map((r, idx) => (
                <div key={idx} style={rowQuadra}>
                  <div title={r.quadra_nome || ""} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.quadra_nome || "-"}
                  </div>
                  <div style={{ textAlign: "right" }}>{r.qtd_pagamentos ?? 0}</div>
                  <div style={{ textAlign: "right" }}>{formatBRL(r.receita_bruta)}</div>
                  <div style={{ textAlign: "right" }}>{formatBRL(r.taxa_plataforma)}</div>
                  <div style={{ textAlign: "right" }}>{formatBRL(r.valor_liquido)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ height: 12 }} />

      {/* ÚLTIMOS PAGAMENTOS */}
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Últimos Pagamentos</h2>

        <div style={{ marginTop: 10 }}>
          {ultimos.length === 0 ? (
            <div style={{ opacity: 0.75, padding: 10 }}>Sem pagamentos no período.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={rowHeadPagamentos}>
                <div>ID</div>
                <div>Data</div>
                <div>Quadra</div>
                <div>Reserva</div>
                <div style={{ textAlign: "right" }}>Bruto</div>
                <div style={{ textAlign: "right" }}>Taxa</div>
                <div style={{ textAlign: "right" }}>Líquido</div>
              </div>

              {ultimos.map((p) => (
                <div key={p.pagamento_id || p.id} style={rowPagamentos}>
                  <div style={mono} title={p.pagamento_id || p.id}>
                    {String(p.pagamento_id || p.id).slice(0, 8)}…
                  </div>
                  <div style={mono}>{p.created_at ? String(p.created_at).slice(0, 10) : "-"}</div>
                  <div title={p.quadra_nome || ""} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.quadra_nome || "-"}
                  </div>
                  <div style={mono}>
                    {p.data_reserva ? `${p.data_reserva} ${p.hora_reserva || ""}` : "-"}
                  </div>
                  <div style={{ textAlign: "right" }}>{formatBRL(p.valor_total)}</div>
                  <div style={{ textAlign: "right" }}>{formatBRL(p.taxa_plataforma)}</div>
                  <div style={{ textAlign: "right" }}>{formatBRL(p.valor_liquido_gestor)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, hint }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.04)"
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

const labelSmall = { display: "block", fontSize: 12, opacity: 0.8, marginBottom: 6 };

const inputStyle = {
  width: "100%",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.25)",
  color: "inherit",
  outline: "none"
};

const btn = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  cursor: "pointer"
};

const btnPrimary = {
  ...btn,
  background: "rgba(0, 160, 255, 0.18)",
  borderColor: "rgba(0, 160, 255, 0.35)"
};

const errorBox = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255, 80, 80, 0.35)",
  background: "rgba(255, 80, 80, 0.10)",
  marginBottom: 12
};

const panel = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.03)"
};

// 5 colunas (Por Quadra)
const rowHeadQuadra = {
  display: "grid",
  gridTemplateColumns: "1fr 70px 120px 120px 120px",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.06)",
  fontSize: 12,
  fontWeight: 700,
  opacity: 0.9,
  alignItems: "center"
};

const rowQuadra = {
  display: "grid",
  gridTemplateColumns: "1fr 70px 120px 120px 120px",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
  alignItems: "center"
};

// 7 colunas (Últimos Pagamentos)
const rowHeadPagamentos = {
  display: "grid",
  gridTemplateColumns: "120px 110px 1fr 140px 110px 110px 110px",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.06)",
  fontSize: 12,
  fontWeight: 700,
  opacity: 0.9,
  alignItems: "center"
};

const rowPagamentos = {
  display: "grid",
  gridTemplateColumns: "120px 110px 1fr 140px 110px 110px 110px",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
  alignItems: "center"
};

const mono = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12
};
