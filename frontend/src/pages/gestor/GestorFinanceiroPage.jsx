// src/pages/gestor/GestorFinanceiroPage.jsx
import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

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
    <div className="page">
      {/* HEADER (igual padrão Admin) */}
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
          <h1 className="page-title">Financeiro (Gestor)</h1>
          <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
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

      {/* FILTROS (card) */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            gap: 12,
            alignItems: "end",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontWeight: 700, fontSize: 13 }}>Início</label>
            <input
              type="date"
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
              className="form-control"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontWeight: 700, fontSize: 13 }}>Fim</label>
            <input
              type="date"
              value={fim}
              onChange={(e) => setFim(e.target.value)}
              className="form-control"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontWeight: 700, fontSize: 13 }}>Status</label>
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

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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

        {erro ? (
          <div style={{ marginTop: 10, color: "#b00020", fontSize: 13 }}>
            {erro}
          </div>
        ) : null}
      </div>

      {/* KPIs (cards) */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Indicadores</h3>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 10,
            marginTop: 12,
          }}
        >
          <div className="vt-card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Receita bruta</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {loading ? "..." : formatBRL(kpis?.receita_bruta)}
            </div>
          </div>

          <div className="vt-card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Taxa plataforma</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {loading ? "..." : formatBRL(kpis?.taxa_plataforma)}
            </div>
          </div>

          <div className="vt-card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Valor líquido</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {loading ? "..." : formatBRL(kpis?.valor_liquido)}
            </div>
          </div>

          <div className="vt-card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Qtd pagamentos</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {loading ? "..." : kpis?.qtd_pagamentos ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* ÚLTIMOS PAGAMENTOS (card) */}
      <div className="vt-card" style={{ padding: 14, marginTop: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>Últimos pagamentos</h3>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ fontSize: 13, color: "#666" }}>Itens/página:</div>
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "160px 160px 1fr",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              background: "#f9f9f9",
              border: "1px solid #eee",
              fontSize: 12,
              fontWeight: 700,
              color: "#666",
            }}
          >
            <div>Data</div>
            <div>Valor</div>
            <div>Status</div>
          </div>

          {/* Linhas */}
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {loading ? (
              <div style={{ padding: 12, color: "#666" }}>Carregando...</div>
            ) : lista.length === 0 ? (
              <div style={{ padding: 12, color: "#666" }}>
                Nenhum pagamento no período.
              </div>
            ) : (
              lista.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "160px 160px 1fr",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #eee",
                    background: "#fff",
                    alignItems: "center",
                  }}
                >
                  <div>{String(p.created_at || "").slice(0, 10) || "-"}</div>
                  <div>{formatBRL(p.valor_total)}</div>
                  <div>{String(p.status || "-")}</div>
                </div>
              ))
            )}
          </div>

          {/* Paginação */}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            <button
              className="btn btn-outline-secondary"
              disabled={paginaSegura <= 1}
              onClick={() => setPagina((x) => Math.max(1, x - 1))}
              type="button"
            >
              Anterior
            </button>

            <div style={{ color: "#666", fontSize: 13 }}>
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

      {/* Responsivo simples */}
      <style>{`
        @media (max-width: 980px) {
          .vt-card > div[style*="gridTemplateColumns: repeat(4"] {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
        @media (max-width: 700px) {
          .vt-card > div[style*="gridTemplateColumns: repeat(2"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
