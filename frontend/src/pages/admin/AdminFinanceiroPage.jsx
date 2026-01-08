// src/pages/admin/AdminFinanceiroPage.jsx
import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";
import "./adminfinanceiro.css";

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

    const qtd_pagamentos = pickNum(resumo, ["qtd_pagamentos", "qtdPagamentos"], 0);
    const total_bruto = pickNum(
      resumo,
      [
        "total_bruto",
        "totalBruto",
        "receita_bruta",
        "receitaBruta",
        "valor_total",
        "valorTotal",
      ],
      0
    );
    const total_taxa = pickNum(
      resumo,
      ["total_taxa", "totalTaxa", "taxa_plataforma", "taxaPlataforma"],
      0
    );
    const total_liquido = pickNum(
      resumo,
      [
        "total_liquido",
        "totalLiquido",
        "valor_liquido",
        "valorLiquido",
        "valor_liquido_gestor",
        "valorLiquidoGestor",
      ],
      0
    );

    const pendentesObj = pickObj(resumo, ["pendentes_repasse", "pendentesRepasse"]);
    const repPendObj = pickObj(resumo, ["repasses_pendentes", "repassesPendentes"]);
    const repPagoObj = pickObj(resumo, ["repasses_pagos", "repassesPagos"]);

    const pendentes_repasse_qtd =
      typeof pendentesObj === "object"
        ? pickNum(pendentesObj, ["qtd", "quantidade", "count"], 0)
        : safeNum(pendentesObj);

    const pendentes_repasse_valor =
      typeof pendentesObj === "object"
        ? pickNum(pendentesObj, ["valor", "total", "valor_total", "valorTotal"], 0)
        : 0;

    const repasses_pendentes_qtd =
      typeof repPendObj === "object"
        ? pickNum(repPendObj, ["qtd", "quantidade", "count"], 0)
        : safeNum(repPendObj);

    const repasses_pendentes_valor =
      typeof repPendObj === "object"
        ? pickNum(repPendObj, ["valor", "total", "valor_total", "valorTotal"], 0)
        : 0;

    const repasses_pagos_qtd =
      typeof repPagoObj === "object"
        ? pickNum(repPagoObj, ["qtd", "quantidade", "count"], 0)
        : safeNum(repPagoObj);

    const repasses_pagos_valor =
      typeof repPagoObj === "object"
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
      receita_bruta: pickNum(
        k,
        ["receita_bruta", "receitaBruta", "total_bruto", "totalBruto"],
        0
      ),
      taxa_plataforma: pickNum(
        k,
        ["taxa_plataforma", "taxaPlataforma", "total_taxa", "totalTaxa"],
        0
      ),
      valor_liquido: pickNum(
        k,
        ["valor_liquido", "valorLiquido", "total_liquido", "totalLiquido"],
        0
      ),
    };
  }, [overview]);

  return (
    <div className="page af-page">
      {/* HEADER */}
      <div className="page-header af-header">
        <div>
          <h1 className="page-title">Financeiro (Admin)</h1>
          <p className="af-subtitle">
            Visão global do período + overview (opcional) por gestor.
          </p>
        </div>

        <div className="af-actions">
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

      {/* FILTROS */}
      <div className="vt-card af-card">
        <div className="af-filters">
          <div className="af-field">
            <label htmlFor="admin_fin_from" className="af-label">
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

          <div className="af-field">
            <label htmlFor="admin_fin_to" className="af-label">
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

          <div className="af-field">
            <label htmlFor="admin_fin_gestor" className="af-label">
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

        {erro ? <div className="af-error">{erro}</div> : null}
      </div>

      {/* RESUMO */}
      <div className="vt-card af-card">
        <div className="af-block-head">
          <h3 className="af-section-title">Resumo global</h3>
          <p className="af-muted">
            Baseado nos pagamentos do período (status:{" "}
            <b>{resumoNorm?.status || "paid"}</b>).
          </p>
        </div>

        {!resumoNorm ? (
          <div className="af-empty">{loading ? "Carregando..." : "Sem dados."}</div>
        ) : (
          <div className="af-kpis af-kpis-3">
            <div className="af-kpi">
              <div className="af-kpi-label">Qtd. pagamentos</div>
              <div className="af-kpi-value">{resumoNorm.qtd_pagamentos}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total bruto</div>
              <div className="af-kpi-value">{formatBRL(resumoNorm.total_bruto)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total líquido (gestores)</div>
              <div className="af-kpi-value">{formatBRL(resumoNorm.total_liquido)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total taxa (plataforma)</div>
              <div className="af-kpi-value">{formatBRL(resumoNorm.total_taxa)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Pendentes de repasse</div>
              <div className="af-kpi-value">{resumoNorm.pendentes_repasse_qtd}</div>
              <div className="af-kpi-sub">{formatBRL(resumoNorm.pendentes_repasse_valor)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Repasses (pendentes / pagos)</div>
              <div className="af-kpi-value">
                {resumoNorm.repasses_pendentes_qtd} / {resumoNorm.repasses_pagos_qtd}
              </div>
              <div className="af-kpi-sub">
                {formatBRL(resumoNorm.repasses_pendentes_valor)} /{" "}
                {formatBRL(resumoNorm.repasses_pagos_valor)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* OVERVIEW */}
      <div className="vt-card af-card">
        <h3 className="af-section-title">
          Overview {gestorId ? "(por gestor)" : "(geral)"}
        </h3>

        {!overviewKpis ? (
          <div className="af-empty">{loading ? "Carregando..." : "Sem dados."}</div>
        ) : (
          <div className="af-kpis af-kpis-4">
            <div className="af-kpi">
              <div className="af-kpi-label">Qtd. pagamentos</div>
              <div className="af-kpi-value">{overviewKpis.qtd_pagamentos}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total bruto</div>
              <div className="af-kpi-value">{formatBRL(overviewKpis.receita_bruta)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total taxa (plataforma)</div>
              <div className="af-kpi-value">{formatBRL(overviewKpis.taxa_plataforma)}</div>
            </div>

            <div className="af-kpi">
              <div className="af-kpi-label">Total líquido (gestores)</div>
              <div className="af-kpi-value">{formatBRL(overviewKpis.valor_liquido)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
