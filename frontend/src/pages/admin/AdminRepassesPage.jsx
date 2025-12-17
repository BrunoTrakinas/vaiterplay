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

export default function AdminRepassesPage() {
  const def = useMemo(() => defaultPeriodo30(), []);
  const [from, setFrom] = useState(def.inicio);
  const [to, setTo] = useState(def.fim);

  const [gestores, setGestores] = useState([]);
  const [gestorId, setGestorId] = useState("");

  const [status, setStatus] = useState(""); // pendente | pago | ""
  const [repasses, setRepasses] = useState([]);

  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");

  // detalhe do repasse
  const [repasseSelecionado, setRepasseSelecionado] = useState(null);
  const [pagamentosDoRepasse, setPagamentosDoRepasse] = useState([]);

  async function carregarGestores() {
    try {
      const { data } = await api.get("/admin/gestores-resumo");
      setGestores(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn("[ADMIN/REPASSES] falha ao carregar gestores:", e);
      setGestores([]);
    }
  }

  async function listarRepasses() {
    setLoading(true);
    setErro("");
    try {
      const { data } = await api.get("/admin/repasses", {
        params: {
          gestorId: gestorId || undefined,
          status: status || undefined
        }
      });
      setRepasses(data?.repasses || []);
    } catch (e) {
      console.error("[ADMIN/REPASSES] erro listar:", e);
      setErro(e?.response?.data?.error || "Erro ao listar repasses.");
      setRepasses([]);
    } finally {
      setLoading(false);
    }
  }

  async function gerarRepasse() {
    if (!gestorId) {
      setErro("Selecione um Gestor para gerar repasse.");
      return;
    }

    setLoading(true);
    setErro("");
    try {
      const body = {
        gestorId,
        from,
        to
        // competencia é opcional; backend aceita, mas não é obrigatório
      };

      const { data } = await api.post("/admin/repasses/gerar", body);

      // Atualiza lista e abre detalhe do repasse criado
      await listarRepasses();

      if (data?.repasse?.id) {
        await abrirDetalhe(data.repasse.id);
      }
    } catch (e) {
      console.error("[ADMIN/REPASSES] erro gerar:", e);
      setErro(e?.response?.data?.error || "Erro ao gerar repasse.");
    } finally {
      setLoading(false);
    }
  }

  async function abrirDetalhe(repasseId) {
    setLoading(true);
    setErro("");
    try {
      const { data } = await api.get(`/admin/repasses/${repasseId}`);
      setRepasseSelecionado(data?.repasse || null);
      setPagamentosDoRepasse(data?.pagamentos || []);
    } catch (e) {
      console.error("[ADMIN/REPASSES] erro detalhe:", e);
      setErro(e?.response?.data?.error || "Erro ao buscar detalhe do repasse.");
      setRepasseSelecionado(null);
      setPagamentosDoRepasse([]);
    } finally {
      setLoading(false);
    }
  }

  async function marcarComoPago(repasseId) {
    setLoading(true);
    setErro("");
    try {
      const body = {
        data_pagamento: new Date().toISOString().slice(0, 10),
        observacao: "Pago manualmente via painel Admin"
      };
      await api.put(`/admin/repasses/${repasseId}/pagar`, body);

      await listarRepasses();
      await abrirDetalhe(repasseId);
    } catch (e) {
      console.error("[ADMIN/REPASSES] erro pagar:", e);
      setErro(e?.response?.data?.error || "Erro ao marcar repasse como pago.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregarGestores();
    listarRepasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 18 }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Repasses (Admin)</h1>
      <p style={{ marginTop: 6, opacity: 0.8 }}>
        Gere repasses por gestor e controle o que o Admin precisa <b>pagar / repassar</b> ao gestor (manual).
      </p>

      <div style={panel}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "260px 160px 160px 160px 1fr",
            gap: 12,
            alignItems: "end"
          }}
        >
          <div>
            <label style={lbl}>Gestor</label>
            <select value={gestorId} onChange={(e) => setGestorId(e.target.value)} style={inputStyle}>
              <option value="">Selecione...</option>
              {gestores.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome} ({g.email})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={lbl}>Início</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={lbl}>Fim</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
          </div>

          <div>
            <label style={lbl}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              <option value="">Todos</option>
              <option value="pendente">Pendente</option>
              <option value="pago">Pago</option>
            </select>
          </div>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button style={btnPrimary} onClick={gerarRepasse} disabled={loading}>
              Gerar repasse (período)
            </button>
            <button
              style={btn}
              onClick={() => {
                const d = defaultPeriodo30();
                setFrom(d.inicio);
                setTo(d.fim);
              }}
            >
              Últimos 30 dias
            </button>
            <button style={btn} onClick={listarRepasses} disabled={loading}>
              Atualizar lista
            </button>
          </div>
        </div>

        {erro ? <div style={{ ...errorBox, marginTop: 12 }}>{erro}</div> : null}
      </div>

      <div style={{ height: 12 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* LISTA */}
        <div style={panel}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Repasses</h2>

          <div style={{ marginTop: 10 }}>
            {loading ? (
              <div style={{ opacity: 0.75, padding: 10 }}>Carregando...</div>
            ) : repasses.length === 0 ? (
              <div style={{ opacity: 0.75, padding: 10 }}>Nenhum repasse encontrado.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={rowHead2}>
                  <div>ID</div>
                  <div>Competência</div>
                  <div>Status</div>
                  <div>Taxa</div>
                  <div>Líquido</div>
                  <div>Ações</div>
                </div>

                {repasses.map((r) => (
                  <div key={r.id} style={row2}>
                    <div style={mono} title={r.id}>{String(r.id).slice(0, 8)}…</div>
                    <div style={mono}>{r.competencia ? String(r.competencia).slice(0, 10) : "-"}</div>
                    <div>{r.status || "-"}</div>
                    <div>{formatBRL(r.valor_total_taxa)}</div>
                    <div>{formatBRL(r.valor_total_liquido)}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={btn} onClick={() => abrirDetalhe(r.id)} disabled={loading}>
                        Ver
                      </button>
                      {String(r.status || "").toLowerCase() !== "pago" ? (
                        <button style={btnPrimary} onClick={() => marcarComoPago(r.id)} disabled={loading}>
                          Marcar pago
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* DETALHE */}
        <div style={panel}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Detalhe do repasse</h2>

          {!repasseSelecionado ? (
            <div style={{ opacity: 0.75, padding: 10, marginTop: 10 }}>
              Selecione um repasse na lista para ver os pagamentos vinculados.
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
                <div><b>ID:</b> <span style={mono}>{repasseSelecionado.id}</span></div>
                <div><b>Status:</b> {repasseSelecionado.status}</div>
                <div><b>Competência:</b> {repasseSelecionado.competencia ? String(repasseSelecionado.competencia).slice(0, 10) : "-"}</div>
                <div><b>Taxa Total:</b> {formatBRL(repasseSelecionado.valor_total_taxa)}</div>
                <div><b>Líquido Total:</b> {formatBRL(repasseSelecionado.valor_total_liquido)}</div>
                <div><b>Data Pagamento:</b> {repasseSelecionado.data_pagamento ? String(repasseSelecionado.data_pagamento).slice(0, 10) : "-"}</div>
              </div>

              <h3 style={{ margin: "10px 0 6px", fontSize: 14 }}>Pagamentos vinculados</h3>
              {pagamentosDoRepasse.length === 0 ? (
                <div style={{ opacity: 0.75, padding: 10 }}>Nenhum pagamento encontrado nesse repasse.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={rowHead3}>
                    <div>ID</div>
                    <div>Data</div>
                    <div>Status</div>
                    <div>Bruto</div>
                    <div>Taxa</div>
                    <div>Líquido</div>
                  </div>

                  {pagamentosDoRepasse.map((p) => (
                    <div key={p.id} style={row3}>
                      <div style={mono} title={p.id}>{String(p.id).slice(0, 8)}…</div>
                      <div style={mono}>{p.created_at ? String(p.created_at).slice(0, 10) : "-"}</div>
                      <div>{p.status || "-"}</div>
                      <div>{formatBRL(p.valor_total)}</div>
                      <div>{formatBRL(p.taxa_plataforma)}</div>
                      <div>{formatBRL(p.valor_liquido_gestor)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const lbl = { display: "block", fontSize: 12, opacity: 0.8, marginBottom: 6 };

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
  background: "rgba(255, 80, 80, 0.10)"
};

const panel = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.03)"
};

const mono = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12
};

const rowHead2 = {
  display: "grid",
  gridTemplateColumns: "90px 110px 90px 110px 110px 1fr",
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

const row2 = {
  display: "grid",
  gridTemplateColumns: "90px 110px 90px 110px 110px 1fr",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
  alignItems: "center"
};

const rowHead3 = {
  display: "grid",
  gridTemplateColumns: "90px 110px 90px 110px 110px 110px",
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

const row3 = {
  display: "grid",
  gridTemplateColumns: "90px 110px 90px 110px 110px 110px",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
  alignItems: "center"
};
