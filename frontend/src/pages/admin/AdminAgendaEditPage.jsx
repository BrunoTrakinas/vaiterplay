import React, { useEffect, useState } from "react";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";

export default function AdminAgendaEditPage() {
  const { usuario } = useAuth();

  const [empresas, setEmpresas] = useState([]);
  const [empresaSelecionadaId, setEmpresaSelecionadaId] = useState("");

  const [quadras, setQuadras] = useState([]);
  const [quadraSelecionadaId, setQuadraSelecionadaId] = useState("");

  const [regras, setRegras] = useState([]);
  const [bloqueios, setBloqueios] = useState([]);

  const [loadingEmpresas, setLoadingEmpresas] = useState(false);
  const [loadingQuadras, setLoadingQuadras] = useState(false);
  const [loadingAgenda, setLoadingAgenda] = useState(false);

  const [erro, setErro] = useState("");
  const [mensagem, setMensagem] = useState("");

  // Edição de regra (linha por linha)
  const [regraEmEdicaoId, setRegraEmEdicaoId] = useState(null);
  const [regraEdicaoForm, setRegraEdicaoForm] = useState({
    dia_semana: "",
    hora_inicio: "",
    hora_fim: "",
    preco_hora: "",
  });

  // Edição de bloqueio (opcional)
  const [bloqueioEmEdicaoId, setBloqueioEmEdicaoId] = useState(null);
  const [bloqueioEdicaoForm, setBloqueioEdicaoForm] = useState({
    data: "",
    hora_inicio: "",
    hora_fim: "",
    motivo: "",
  });

  function formatarNomeEmpresa(empresa) {
    if (!empresa) return "—";
    const nome = empresa.nome || "Empresa";
    const end = empresa.endereco_resumo ? ` — ${empresa.endereco_resumo}` : "";
    return `${nome}${end}`;
  }

  function formatarNomeQuadra(q) {
    if (!q) return "—";
    if (q.nome_dinamico) return q.nome_dinamico;
    const parts = [q.tipo, q.material, q.modalidade].filter(Boolean);
    return parts.join(" / ") || q.id;
  }

  // 1) Carregar empresas (ADMIN)
  useEffect(() => {
    if (!usuario) return;

    async function carregarEmpresas() {
      try {
        setLoadingEmpresas(true);
        setErro("");
        setMensagem("");

        const { data } = await api.get("/admin/empresas");
        const lista = Array.isArray(data) ? data : data.empresas || data || [];
        setEmpresas(lista);
      } catch (err) {
        console.error("[AdminAgendaEditPage] Erro ao buscar empresas:", err);
        const msg = err.response?.data?.error || "Erro ao carregar empresas. Faça login novamente.";
        setErro(msg);
      } finally {
        setLoadingEmpresas(false);
      }
    }

    carregarEmpresas();
  }, [usuario]);

  // 2) Quando escolhe empresa → carrega quadras dessa empresa (ADMIN)
  useEffect(() => {
    if (!empresaSelecionadaId) {
      setQuadras([]);
      setQuadraSelecionadaId("");
      setRegras([]);
      setBloqueios([]);
      return;
    }

    async function carregarQuadras() {
      try {
        setLoadingQuadras(true);
        setErro("");
        setMensagem("");

        const { data } = await api.get("/admin/quadras", { params: { empresaId: empresaSelecionadaId } });
        const lista = Array.isArray(data) ? data : data.quadras || data || [];
        setQuadras(lista);

        setQuadraSelecionadaId("");
        setRegras([]);
        setBloqueios([]);
      } catch (err) {
        console.error("[AdminAgendaEditPage] Erro ao buscar quadras:", err);
        const msg = err.response?.data?.error || "Erro ao carregar quadras para esse complexo.";
        setErro(msg);
      } finally {
        setLoadingQuadras(false);
      }
    }

    carregarQuadras();
  }, [empresaSelecionadaId]);

  // 3) Quando escolhe quadra → carrega regras + bloqueios (ADMIN)
  useEffect(() => {
    if (!quadraSelecionadaId) {
      setRegras([]);
      setBloqueios([]);
      return;
    }

    async function carregarAgenda() {
      try {
        setLoadingAgenda(true);
        setErro("");
        setMensagem("");

        const respRegras = await api.get("/admin/agenda/regras", { params: { quadraId: quadraSelecionadaId } });
        const bodyRegras = respRegras.data;
        setRegras(bodyRegras.regras || bodyRegras || []);

        const respBloqueios = await api.get("/admin/agenda/bloqueios", { params: { quadraId: quadraSelecionadaId } });
        const bodyBloqueios = respBloqueios.data;
        setBloqueios(bodyBloqueios.bloqueios || bodyBloqueios || []);
      } catch (err) {
        console.error("[AdminAgendaEditPage] Erro ao carregar agenda:", err);
        const msg = err.response?.data?.error || "Erro ao carregar regras/bloqueios dessa quadra.";
        setErro(msg);
      } finally {
        setLoadingAgenda(false);
      }
    }

    carregarAgenda();
  }, [quadraSelecionadaId]);

  // CRUD Regra (ADMIN)
  async function salvarRegraEdicao(regraId) {
    try {
      setErro("");
      setMensagem("");

      await api.put(`/admin/agenda/regras/${regraId}`, {
        quadraId: quadraSelecionadaId,
        diaSemana: regraEdicaoForm.dia_semana,
        horaInicio: regraEdicaoForm.hora_inicio,
        horaFim: regraEdicaoForm.hora_fim,
        precoHora: regraEdicaoForm.preco_hora,
      });

      setMensagem("Regra atualizada.");
      setRegraEmEdicaoId(null);

      const respRegras = await api.get("/admin/agenda/regras", { params: { quadraId: quadraSelecionadaId } });
      setRegras(respRegras.data?.regras || []);
    } catch (err) {
      console.error("[AdminAgendaEditPage] Erro ao salvar regra:", err);
      setErro(err.response?.data?.error || "Erro ao salvar regra.");
    }
  }

  async function excluirRegra(regraId) {
    try {
      setErro("");
      setMensagem("");

      await api.delete(`/admin/agenda/regras/${regraId}`);
      setMensagem("Regra excluída.");

      const respRegras = await api.get("/admin/agenda/regras", { params: { quadraId: quadraSelecionadaId } });
      setRegras(respRegras.data?.regras || []);
    } catch (err) {
      console.error("[AdminAgendaEditPage] Erro ao excluir regra:", err);
      setErro(err.response?.data?.error || "Erro ao excluir regra.");
    }
  }

  // CRUD Bloqueio (ADMIN)
  async function excluirBloqueio(bloqueioId) {
    try {
      setErro("");
      setMensagem("");

      await api.delete(`/admin/agenda/bloqueios/${bloqueioId}`);
      setMensagem("Bloqueio excluído.");

      const resp = await api.get("/admin/agenda/bloqueios", { params: { quadraId: quadraSelecionadaId } });
      setBloqueios(resp.data?.bloqueios || []);
    } catch (err) {
      console.error("[AdminAgendaEditPage] Erro ao excluir bloqueio:", err);
      setErro(err.response?.data?.error || "Erro ao excluir bloqueio.");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Agenda (Admin) — Avançado</h1>
        <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
          Clone do Avançado do Gestor — Admin com permissão global.
        </p>
      </div>

      {erro && <div className="alert-erro-agenda">{erro}</div>}
      {mensagem && <div className="alert-sucesso">{mensagem}</div>}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="form-grid" style={{ maxWidth: 900 }}>
          <div className="form-field">
            <label>Empresa / Complexo</label>
            <select value={empresaSelecionadaId} onChange={(e) => setEmpresaSelecionadaId(e.target.value)}>
              <option value="">{loadingEmpresas ? "Carregando..." : "Selecione uma empresa"}</option>
              {empresas.map((em) => (
                <option key={em.id} value={em.id}>
                  {formatarNomeEmpresa(em)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label>Quadra</label>
            <select
              value={quadraSelecionadaId}
              onChange={(e) => setQuadraSelecionadaId(e.target.value)}
              disabled={!empresaSelecionadaId || loadingQuadras}
            >
              <option value="">
                {!empresaSelecionadaId ? "Selecione uma empresa primeiro" : loadingQuadras ? "Carregando..." : "Selecione uma quadra"}
              </option>
              {quadras.map((q) => (
                <option key={q.id} value={q.id}>
                  {formatarNomeQuadra(q)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loadingAgenda && <p style={{ marginTop: 12 }}>Carregando agenda...</p>}

      {!!quadraSelecionadaId && !loadingAgenda && (
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Regras */}
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Regras de Horário</h3>

            {regras.length === 0 && <p>Nenhuma regra cadastrada.</p>}

            {regras.map((r) => (
              <div
                key={r.id}
                style={{ border: "1px solid #eee", borderRadius: 10, padding: 10, marginBottom: 10, background: "#fff" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>
                    Dia {r.dia_semana} — {r.hora_inicio} às {r.hora_fim} — R$ {r.preco_hora}
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn btn-outline-secondary"
                      onClick={() => {
                        setRegraEmEdicaoId(r.id);
                        setRegraEdicaoForm({
                          dia_semana: r.dia_semana,
                          hora_inicio: r.hora_inicio,
                          hora_fim: r.hora_fim,
                          preco_hora: r.preco_hora,
                        });
                      }}
                    >
                      Editar
                    </button>

                    <button className="btn btn-danger" onClick={() => excluirRegra(r.id)}>
                      Excluir
                    </button>
                  </div>
                </div>

                {regraEmEdicaoId === r.id && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                    <input
                      placeholder="dia_semana"
                      value={regraEdicaoForm.dia_semana}
                      onChange={(e) => setRegraEdicaoForm((s) => ({ ...s, dia_semana: e.target.value }))}
                    />
                    <input
                      placeholder="hora_inicio"
                      value={regraEdicaoForm.hora_inicio}
                      onChange={(e) => setRegraEdicaoForm((s) => ({ ...s, hora_inicio: e.target.value }))}
                    />
                    <input
                      placeholder="hora_fim"
                      value={regraEdicaoForm.hora_fim}
                      onChange={(e) => setRegraEdicaoForm((s) => ({ ...s, hora_fim: e.target.value }))}
                    />
                    <input
                      placeholder="preco_hora"
                      value={regraEdicaoForm.preco_hora}
                      onChange={(e) => setRegraEdicaoForm((s) => ({ ...s, preco_hora: e.target.value }))}
                    />

                    <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                      <button className="btn btn-success" onClick={() => salvarRegraEdicao(r.id)}>
                        Salvar
                      </button>
                      <button className="btn btn-outline-secondary" onClick={() => setRegraEmEdicaoId(null)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Bloqueios */}
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Bloqueios</h3>

            {bloqueios.length === 0 && <p>Nenhum bloqueio cadastrado.</p>}

            {bloqueios.map((b) => (
              <div
                key={b.id}
                style={{ border: "1px solid #eee", borderRadius: 10, padding: 10, marginBottom: 10, background: "#fff" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>
                    {b.data} — {b.hora_inicio} às {b.hora_fim} {b.motivo ? `— ${b.motivo}` : ""}
                  </div>

                  <button className="btn btn-danger" onClick={() => excluirBloqueio(b.id)}>
                    Excluir
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
