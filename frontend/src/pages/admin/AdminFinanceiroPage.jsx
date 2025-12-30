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
  if (!Number.isFinite(n)) return "R$ 0,00";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickNum(obj, keys, fallback = 0) {
  if (!obj) return fallback;
  for (const k of keys) {
    const val = obj?.[k];
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function pickObj(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const val = obj?.[k];
    if (val !== undefined && val !== null) return val;
  }
  return null;
}

export default function AdminFinanceiroPage() {
  const def = useMemo(() => defaultPeriodo30(), []);
  const [from, setFrom] = useState(def.inicio);
  const [to, setTo] = useState(def.fim);

  const [gestores, setGestores] = useState([]);
  const [gestorId, setGestorId] = useState("");

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");

  const [overview, setOverview] = useState(null);
  const [resumo, setResumo] = useState(null);

  async function carregarGestores() {
    try {
      const { data } = await api.get("/admin/gestores-resumo");
      setGestores(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn("[ADMIN/FINANCEIRO] falha ao carregar gestores:", e);
    }
  }

  async function carregarTudo() {
    setErro("");
    setLoading(true);
    try {
      const params = {
        from,
        to,
        status: "paid",
        gestorId: gestorId || undefined,
      };

      const [rOverview, rResumo] = await Promise.all([
        api.get("/admin/financeiro-overview", { params }),
        api.get("/admin/financeiro/resumo", { params }),
      ]);

      setOverview(rOverview?.data || null);
      setResumo(rResumo?.data || null);
    } catch (e) {
      console.error("[ADMIN/FINANCEIRO] erro ao carregar:", e);
      setErro(
        e?.response?.data?.error || e?.message || "Falha ao carregar financeiro."
      );
      setOverview(null);
      setResumo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregarGestores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    carregarTudo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, gestorId]);

  // Normalização defensiva do RESUMO (aceita backend antigo/novo)
  const resumoNorm = useMemo(() => {
    if (!resumo) return null;

    // totais principais (aceita nomes diferentes)
    const qtd_pagamentos = pickNum(resumo, ["qtd_pagamentos", "qtdPagamentos"], 0);
    const total_bruto = pickNum(
      resumo,
      ["total_bruto", "totalBruto", "receita_bruta", "receitaBruta", "valor_total", "valorTotal"],
      0
    );
    const total_taxa = pickNum(
      resumo,
      ["total_taxa", "totalTaxa", "taxa_plataforma", "taxaPlataforma"],
      0
    );
    const total_liquido = pickNum(
      resumo,
      ["total_liquido", "totalLiquido", "valor_liquido", "valorLiquido", "valor_liquido_gestor", "valorLiquidoGestor"],
      0
    );

    // campos que às vezes vêm como { qtd, valor }
    const pendentesObj = pickObj(resumo, ["pendentes_repasse", "pendentesRepasse"]);
    const repPendObj = pickObj(resumo, ["repasses_pendentes", "repassesPendentes"]);
    const repPagoObj = pickObj(resumo, ["repasses_pagos", "repassesPagos"]);

    const pendentes_repasse_qtd = typeof pendentesObj === "object"
      ? pickNum(pendentesObj, ["qtd", "quantidade", "count"], 0)
      : safeNum(pendentesObj);

    const pendentes_repasse_valor = typeof pendentesObj === "object"
      ? pickNum(pendentesObj, ["valor", "total", "valor_total", "valorTotal"], 0)
      : 0;

    const repasses_pendentes_qtd = typeof repPendObj === "object"
      ? pickNum(repPendObj, ["qtd", "quantidade", "count"], 0)
      : safeNum(repPendObj);

    const repasses_pendentes_valor = typeof repPendObj === "object"
      ? pickNum(repPendObj, ["valor", "total", "valor_total", "valorTotal"], 0)
      : 0;

    const repasses_pagos_qtd = typeof repPagoObj === "object"
      ? pickNum(repPagoObj, ["qtd", "quantidade", "count"], 0)
      : safeNum(repPagoObj);

    const repasses_pagos_valor = typeof repPagoObj === "object"
      ? pickNum(repPagoObj, ["valor", "total", "valor_total", "valorTotal"], 0)
      : 0;

    return {
      periodo: resumo.periodo || { inicio: from, fim: to },
      status: resumo.status || "paid",
      qtd_pagamentos,
      total_bruto,
      total_taxa,
      total_liquido,
      pendentes_repasse_qtd,
      pendentes_repasse_valor,
      repasses_pendentes_qtd,
      repasses_pendentes_valor,
      repasses_pagos_qtd,
      repasses_pagos_valor,
    };
  }, [resumo, from, to]);

  // Normalização do OVERVIEW (usa overview.kpis quando existir)
  const overviewKpis = useMemo(() => {
    if (!overview) return null;
    const k = overview.kpis || overview.KPIS || null;
    if (!k) return null;
    return {
      qtd_pagamentos: pickNum(k, ["qtd_pagamentos", "qtdPagamentos"], 0),
      receita_bruta: pickNum(k, ["receita_bruta", "receitaBruta", "total_bruto", "totalBruto"], 0),
      taxa_plataforma: pickNum(k, ["taxa_plataforma", "taxaPlataforma", "total_taxa", "totalTaxa"], 0),
      valor_liquido: pickNum(k, ["valor_liquido", "valorLiquido", "total_liquido", "totalLiquido"], 0),
    };
  }, [overview]);

  return (
    <div className="page">
      <div
        className="page-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 className="page-title">Financeiro (Admin)</h1>
          <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
            Visão global do período + overview (opcional) por gestor.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            className="btn btn-outline-secondary"
            onClick={carregarTudo}
            disabled={loading}
            type="button"
          >
            {loading ? "Carregando..." : "Recarregar"}
          </button>
        </div>
      </div>

      {/* filtros */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 2fr",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="admin_fin_from"
              style={{ fontWeight: 700, fontSize: 13 }}
            >
              De
            </label>
            <input
              id="admin_fin_from"
              name="admin_fin_from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="form-control"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="admin_fin_to"
              style={{ fontWeight: 700, fontSize: 13 }}
            >
              Até
            </label>
            <input
              id="admin_fin_to"
              name="admin_fin_to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="form-control"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="admin_fin_gestor"
              style={{ fontWeight: 700, fontSize: 13 }}
            >
              Filtrar por gestor (opcional)
            </label>
            <select
              id="admin_fin_gestor"
              name="admin_fin_gestor"
              value={gestorId}
              onChange={(e) => setGestorId(e.target.value)}
              className="form-control"
            >
              <option value="">(Todos)</option>
              {(gestores || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome || g.email || g.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        {erro ? (
          <div style={{ marginTop: 10, color: "#b00020", fontSize: 13 }}>
            {erro}
          </div>
        ) : null}
      </div>

      {/* resumo */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Resumo global</h3>
        <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
          Baseado nos pagamentos do período (status:{" "}
          <b>{resumoNorm?.status || "paid"}</b>).
        </p>

        {!resumoNorm ? (
          <div style={{ marginTop: 10, color: "#666" }}>
            {loading ? "Carregando..." : "Sem dados."}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 10,
              marginTop: 12,
            }}
          >
            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>Qtd. pagamentos</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {resumoNorm.qtd_pagamentos}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>Total bruto</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(resumoNorm.total_bruto)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Total líquido (gestores)
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(resumoNorm.total_liquido)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Total taxa (plataforma)
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(resumoNorm.total_taxa)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Pendentes de repasse
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {resumoNorm.pendentes_repasse_qtd}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                {formatBRL(resumoNorm.pendentes_repasse_valor)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Repasses (pendentes / pagos)
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {resumoNorm.repasses_pendentes_qtd} / {resumoNorm.repasses_pagos_qtd}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                {formatBRL(resumoNorm.repasses_pendentes_valor)} /{" "}
                {formatBRL(resumoNorm.repasses_pagos_valor)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* overview */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>
          Overview {gestorId ? "(por gestor)" : "(geral)"}
        </h3>

        {!overviewKpis ? (
          <div style={{ marginTop: 10, color: "#666" }}>
            {loading ? "Carregando..." : "Sem dados."}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 10,
              marginTop: 12,
            }}
          >
            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>Qtd. pagamentos</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {overviewKpis.qtd_pagamentos}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>Total bruto</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(overviewKpis.receita_bruta)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Total taxa (plataforma)
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(overviewKpis.taxa_plataforma)}
              </div>
            </div>

            <div className="vt-card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: "#666" }}>
                Total líquido (gestores)
              </div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                {formatBRL(overviewKpis.valor_liquido)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
