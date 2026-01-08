// src/pages/gestor/GestorFinanceiroPage.jsx
import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";
import "./gestorfinanceiro.css";

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultPeriodo30() {
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(fim.getDate() - 30);
  return { inicio: toISODate(inicio), fim: toISODate(fim) };
}

function formatBRL(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return "R$ 0,00";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function GestorFinanceiroPage() {
  const def = useMemo(() => defaultPeriodo30(), []);
  const [inicio, setInicio] = useState(def.inicio);
  const [fim, setFim] = useState(def.fim);
  const [status, setStatus] = useState("paid");

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");

  const [pagina, setPagina] = useState(1);
  const [limite, setLimite] = useState(20);

  // --- VISUAL ONLY (não altera regra/dados) ---
  function statusLabel(s) {
    const v = String(s || "").toLowerCase();
    if (v === "paid") return "Pago";
    if (v === "canceled" || v === "cancelled") return "Cancelado";
    return v || "-";
  }

  function statusClass(s) {
    const v = String(s || "").toLowerCase();
    if (v === "paid") return "paid";
    if (v === "canceled" || v === "cancelled") return "canceled";
    // fallback visual neutro
    return "pending";
  }
  // -------------------------------------------

  async function carregarOverview() {
    setLoading(true);
    setErro("");

    try {
      const { data } = await api.get("/gestor/financeiro-overview", {
        params: { from: inicio, to: fim, status },
      });

      setOverview(data || null);
      setPagina(1);
    } catch (e) {
      console.error("[GESTOR/FINANCEIRO] erro overview:", e);
      setErro(
        e?.response?.data?.error ||
          "Erro ao carregar financeiro. Verifique sua conexão e tente novamente."
      );
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }

  function aplicarFiltro() {
    setPagina(1);
    carregarOverview();
  }

  useEffect(() => {
    aplicarFiltro();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function limparPeriodo() {
    const d = defaultPeriodo30();
    setInicio(d.inicio);
    setFim(d.fim);
    setStatus("paid");
    setPagina(1);
    setLimite(20);
    setTimeout(() => {
      carregarOverview();
    }, 0);
  }

  const kpis = overview?.kpis || {};
  const listaAll = Array.isArray(overview?.ultimos_pagamentos)
    ? overview.ultimos_pagamentos
    : [];

  const totalPaginas = Math.max(1, Math.ceil(listaAll.length / limite));
  const paginaSegura = Math.min(Math.max(1, pagina), totalPaginas);
  const lista = listaAll.slice(
    (paginaSegura - 1) * limite,
    paginaSegura * limite
  );

  return (
    <div className="page gf-page">
      {/* HEADER */}
      <div className="page-header gf-header">
        <div>
          <h1 className="page-title">Financeiro (Gestor)</h1>
          <p className="gf-subtitle">
            Indicadores e últimos pagamentos confirmados no período selecionado.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn btn-outline-secondary"
            onClick={carregarOverview}
            disabled={loading}
            type="button"
          >
            {loading ? "Carregando..." : "Recarregar"}
          </button>
        </div>
      </div>

      {/* FILTROS */}
      <div className="vt-card gf-card">
        <div className="gf-filters">
          <div className="gf-field">
            <label className="gf-label">Início</label>
            <input
              type="date"
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
              className="form-control"
            />
          </div>

          <div className="gf-field">
            <label className="gf-label">Fim</label>
            <input
              type="date"
              value={fim}
              onChange={(e) => setFim(e.target.value)}
              className="form-control"
            />
          </div>

          <div className="gf-field">
            <label className="gf-label">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="form-control"
            >
              <option value="paid">Pago</option>
              <option value="canceled">Cancelado</option>
              <option value="cancelled">Cancelado (variação)</option>
            </select>
          </div>

          <div className="gf-actions">
            <button
              className="btn btn-primary"
              onClick={aplicarFiltro}
              disabled={loading}
              type="button"
            >
              Aplicar
            </button>
            <button
              className="btn btn-outline-secondary"
              onClick={limparPeriodo}
              disabled={loading}
              type="button"
            >
              Últimos 30 dias
            </button>
          </div>
        </div>

        {erro ? <div className="gf-error">{erro}</div> : null}
      </div>

      {/* KPIs */}
      <div className="vt-card gf-card">
        <h3 className="gf-section-title">Indicadores</h3>

        <div className="gf-kpis">
          <div className="gf-kpi">
            <div className="gf-kpi-label">Receita bruta</div>
            <div className="gf-kpi-value">
              {loading ? "..." : formatBRL(kpis?.receita_bruta)}
            </div>
          </div>

          <div className="gf-kpi">
            <div className="gf-kpi-label">Taxa plataforma</div>
            <div className="gf-kpi-value">
              {loading ? "..." : formatBRL(kpis?.taxa_plataforma)}
            </div>
          </div>

          <div className="gf-kpi">
            <div className="gf-kpi-label">Valor líquido</div>
            <div className="gf-kpi-value">
              {loading ? "..." : formatBRL(kpis?.valor_liquido)}
            </div>
          </div>

          <div className="gf-kpi">
            <div className="gf-kpi-label">Qtd pagamentos</div>
            <div className="gf-kpi-value">
              {loading ? "..." : kpis?.qtd_pagamentos ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* ÚLTIMOS PAGAMENTOS */}
      <div className="vt-card gf-card">
        <div className="gf-table-top">
          <h3 className="gf-section-title">Últimos pagamentos</h3>

          <div className="gf-table-controls">
            <div className="gf-muted">Itens/página:</div>
            <select
              value={limite}
              onChange={(e) => setLimite(Number(e.target.value))}
              className="form-control"
              style={{ width: 110 }}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          {/* Cabeçalho */}
          <div className="gf-table-head">
            <div>Data</div>
            <div>Valor</div>
            <div>Status</div>
          </div>

          {/* Linhas */}
          <div className="gf-table-rows">
            {loading ? (
              <div style={{ padding: 12, color: "#666" }}>Carregando...</div>
            ) : lista.length === 0 ? (
              <div style={{ padding: 12, color: "#666" }}>
                Nenhum pagamento no período.
              </div>
            ) : (
              lista.map((p) => {
                const cls = statusClass(p.status);
                return (
                  <div key={p.id} className="gf-row">
                    <div>{String(p.created_at || "").slice(0, 10) || "-"}</div>
                    <div>{formatBRL(p.valor_total)}</div>
                    <div>
                      <span className={`gf-badge gf-badge-${cls}`}>
                        <span className={`gf-dot gf-dot-${cls}`} />
                        {statusLabel(p.status)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Paginação */}
          <div className="gf-pagination">
            <button
              className="btn btn-outline-secondary"
              disabled={paginaSegura <= 1}
              onClick={() => setPagina((x) => Math.max(1, x - 1))}
              type="button"
            >
              Anterior
            </button>

            <div className="gf-muted">
              Página {paginaSegura} / {totalPaginas}
            </div>

            <button
              className="btn btn-outline-secondary"
              disabled={paginaSegura >= totalPaginas}
              onClick={() => setPagina((x) => Math.min(totalPaginas, x + 1))}
              type="button"
            >
              Próxima
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
