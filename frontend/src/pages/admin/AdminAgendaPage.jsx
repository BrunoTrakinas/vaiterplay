import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";

// Reaproveita o MESMO componente do Gestor
import AgendaCinemaView from "../../components/gestor/AgendaCinemaView";

// Componentes padrão da pasta agenda (iguais ao Gestor)
import { AgendaFilters } from "../../components/agenda/AgendaFilters";
import { AgendaLegend } from "../../components/agenda/AgendaLegend";
import { AgendaGrid } from "../../components/agenda/AgendaGrid";
import { AgendaToolbar } from "../../components/agenda/AgendaToolbar";
import AgendaRegrasBox from "../../components/agenda/AgendaRegrasBox";
import AgendaBloqueiosBox from "../../components/agenda/AgendaBloqueiosBox";


function AdminAgendaPage() {
  const { usuario } = useAuth();

  const [empresas, setEmpresas] = useState([]);
  const [quadras, setQuadras] = useState([]);

  const [empresaSelecionadaId, setEmpresaSelecionadaId] = useState("");
  const [quadraSelecionadaId, setQuadraSelecionadaId] = useState("");

  const [regras, setRegras] = useState([]);
  const [bloqueios, setBloqueios] = useState([]);

  const [carregandoEmpresas, setCarregandoEmpresas] = useState(false);
  const [carregandoQuadras, setCarregandoQuadras] = useState(false);
  const [carregandoAgenda, setCarregandoAgenda] = useState(false);

  const [erroEmpresas, setErroEmpresas] = useState("");
  const [erroQuadras, setErroQuadras] = useState("");
  const [erroAgenda, setErroAgenda] = useState("");

  const [mensagem, setMensagem] = useState("");

  const [periodo, setPeriodo] = useState("semana");
  const [filtroStatus, setFiltroStatus] = useState("todas");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");

  // Form de regra (mesmo do Gestor)
  const [regraForm, setRegraForm] = useState({
    diaSemana: "",
    horaInicio: "",
    horaFim: "",
    precoHora: "",
    ativo: true,
  });
  const [regraEditandoId, setRegraEditandoId] = useState(null);
  const [editingQuadraId, setEditingQuadraId] = useState(null);
  const [salvandoRegra, setSalvandoRegra] = useState(false);
  const [excluindoRegraId, setExcluindoRegraId] = useState(null);

  // Seleção em lote (regras + bloqueios)
  const [selectedQuadraIds, setSelectedQuadraIds] = useState([]);
  const [diasSelecionados, setDiasSelecionados] = useState([]);

  // Form de bloqueio
  const [bloqueioForm, setBloqueioForm] = useState({
    data: "",
    horaInicio: "",
    horaFim: "",
    motivo: "",
  });
  const [bloquearComplexoInteiro, setBloquearComplexoInteiro] = useState(false);
  const [salvandoBloqueio, setSalvandoBloqueio] = useState(false);
  const [excluindoBloqueioId, setExcluindoBloqueioId] = useState(null);

  // -----------------------------
  // Helpers de label (clone total)
  // -----------------------------
  function formatarNomeEmpresa(empresa) {
    if (!empresa) return "—";
    const nome = empresa.nome || "Empresa";
    const end = empresa.endereco_resumo ? ` — ${empresa.endereco_resumo}` : "";
    return `${nome}${end}`;
  }

  function formatarNomeQuadra(q) {
    if (!q) return "—";
    // se seu backend já devolve nome_dinamico
    if (q.nome_dinamico) return q.nome_dinamico;
    const parts = [q.tipo, q.material, q.modalidade].filter(Boolean);
    return parts.join(" / ") || q.id;
  }

  function resetRegraForm() {
    setRegraForm({ diaSemana: "", horaInicio: "", horaFim: "", precoHora: "", ativo: true });
    setRegraEditandoId(null);
    setEditingQuadraId(null);
  }

  function resetBloqueioForm() {
    setBloqueioForm({ data: "", horaInicio: "", horaFim: "", motivo: "" });
  }

  // -----------------------------------
  // 1) Carregar empresas (ADMIN = global)
  // -----------------------------------
  async function carregarEmpresas() {
    try {
      setCarregandoEmpresas(true);
      setErroEmpresas("");
      setMensagem("");

      const { data } = await api.get("/admin/empresas");
      setEmpresas(Array.isArray(data) ? data : data.empresas || []);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao buscar empresas:", err);
      const msg = err.response?.data?.error || "Erro ao carregar empresas. Tente novamente.";
      setErroEmpresas(msg);
    } finally {
      setCarregandoEmpresas(false);
    }
  }

  useEffect(() => {
    if (!usuario) return;
    carregarEmpresas();
  }, [usuario]);

  // -----------------------------------
  // 2) Carregar quadras da empresa selecionada (ADMIN = global)
  // -----------------------------------
  async function carregarQuadrasDaEmpresa(empresaId) {
    if (!empresaId) {
      setQuadras([]);
      setQuadraSelecionadaId("");
      setErroQuadras("");
      setSelectedQuadraIds([]);
      return;
    }

    try {
      setCarregandoQuadras(true);
      setErroQuadras("");
      setMensagem("");

      const { data } = await api.get("/admin/quadras", { params: { empresaId } });
      const lista = Array.isArray(data) ? data : data.quadras || [];
      setQuadras(lista);

      if (lista.length === 0) {
        setQuadraSelecionadaId("");
        setSelectedQuadraIds([]);
      }
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao buscar quadras:", err);
      const msg = err.response?.data?.error || "Erro ao carregar quadras da empresa selecionada.";
      setErroQuadras(msg);
      setQuadras([]);
      setQuadraSelecionadaId("");
      setSelectedQuadraIds([]);
    } finally {
      setCarregandoQuadras(false);
    }
  }

  function handleSelecionarEmpresa(e) {
    const id = e.target.value;
    setEmpresaSelecionadaId(id);

    setQuadras([]);
    setQuadraSelecionadaId("");
    setSelectedQuadraIds([]);
    setRegras([]);
    setBloqueios([]);
    setErroAgenda("");
    setMensagem("");
    setDiasSelecionados([]);
    resetRegraForm();
    resetBloqueioForm();
    setBloquearComplexoInteiro(false);

    if (id) carregarQuadrasDaEmpresa(id);
  }

  useEffect(() => {
    if (quadraSelecionadaId) setSelectedQuadraIds([quadraSelecionadaId]);
    else setSelectedQuadraIds([]);
  }, [quadraSelecionadaId]);

  // -----------------------------------
  // 3) Buscar regras e bloqueios da quadra (ADMIN)
  // -----------------------------------
  async function carregarAgendaDaQuadra(quadraId) {
    if (!quadraId) {
      setRegras([]);
      setBloqueios([]);
      setErroAgenda("");
      setMensagem("");
      return;
    }

    try {
      setCarregandoAgenda(true);
      setErroAgenda("");
      setMensagem("");

      const [respRegras, respBloqueios] = await Promise.all([
        api.get("/admin/agenda/regras", { params: { quadraId } }),
        api.get("/admin/agenda/bloqueios", { params: { quadraId } }),
      ]);

      setRegras(respRegras.data?.regras || []);
      setBloqueios(respBloqueios.data?.bloqueios || []);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao buscar agenda:", err);
      const msg = err.response?.data?.error || "Erro ao carregar regras/bloqueios da quadra.";
      setErroAgenda(msg);
      setRegras([]);
      setBloqueios([]);
    } finally {
      setCarregandoAgenda(false);
    }
  }

  function handleSelecionarQuadra(e) {
    const id = e.target.value;
    setQuadraSelecionadaId(id);

    setRegras([]);
    setBloqueios([]);
    setErroAgenda("");
    setMensagem("");
    setDiasSelecionados([]);
    resetRegraForm();
    resetBloqueioForm();
    setBloquearComplexoInteiro(false);

    if (id) carregarAgendaDaQuadra(id);
  }

  // -----------------------------------
  // 4) CRUD Regras (ADMIN)
  // -----------------------------------
  async function salvarRegra() {
    try {
      setSalvandoRegra(true);
      setMensagem("");
      setErroAgenda("");

      const quadraIdAlvo = editingQuadraId || quadraSelecionadaId;
      if (!quadraIdAlvo) {
        setErroAgenda("Selecione uma quadra para criar/editar regras.");
        return;
      }

      const payload = {
        quadraId: quadraIdAlvo,
        diaSemana: regraForm.diaSemana,
        horaInicio: regraForm.horaInicio,
        horaFim: regraForm.horaFim,
        precoHora: regraForm.precoHora,
        ativo: regraForm.ativo,
      };

      if (regraEditandoId) {
        await api.put(`/admin/agenda/regras/${regraEditandoId}`, payload);
        setMensagem("Regra atualizada com sucesso.");
      } else {
        await api.post("/admin/agenda/regras", payload);
        setMensagem("Regra criada com sucesso.");
      }

      resetRegraForm();
      carregarAgendaDaQuadra(quadraSelecionadaId);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao salvar regra:", err);
      setErroAgenda(err.response?.data?.error || "Erro ao salvar regra.");
    } finally {
      setSalvandoRegra(false);
    }
  }

  async function excluirRegra(regraId) {
    try {
      setExcluindoRegraId(regraId);
      setMensagem("");
      setErroAgenda("");

      await api.delete(`/admin/agenda/regras/${regraId}`);
      setMensagem("Regra excluída.");
      carregarAgendaDaQuadra(quadraSelecionadaId);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao excluir regra:", err);
      setErroAgenda(err.response?.data?.error || "Erro ao excluir regra.");
    } finally {
      setExcluindoRegraId(null);
    }
  }

  async function aplicarRegrasEmLote({ quadraIds, dias, horaInicio, horaFim, precoHora, ativo }) {
    try {
      setSalvandoRegra(true);
      setMensagem("");
      setErroAgenda("");

      await api.post("/admin/agenda/regras/lote", {
        quadraIds,
        dias,
        horaInicio,
        horaFim,
        precoHora,
        ativo,
      });

      setMensagem("Regras aplicadas em lote com sucesso.");
      carregarAgendaDaQuadra(quadraSelecionadaId);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao aplicar regras em lote:", err);
      setErroAgenda(err.response?.data?.error || "Erro ao aplicar regras em lote.");
    } finally {
      setSalvandoRegra(false);
    }
  }

  // -----------------------------------
  // 5) CRUD Bloqueios (ADMIN)
  // -----------------------------------
  async function salvarBloqueio({ quadraIds, data, horaInicio, horaFim, motivo }) {
    try {
      setSalvandoBloqueio(true);
      setMensagem("");
      setErroAgenda("");

      // Lote
      if (Array.isArray(quadraIds) && quadraIds.length > 0) {
        await api.post("/admin/agenda/bloqueios/lote", {
          quadraIds,
          data,
          horaInicio,
          horaFim,
          motivo,
        });
        setMensagem("Bloqueios aplicados em lote com sucesso.");
        carregarAgendaDaQuadra(quadraSelecionadaId);
        return;
      }

      // Unitário
      const quadraIdAlvo = quadraSelecionadaId;
      if (!quadraIdAlvo) {
        setErroAgenda("Selecione uma quadra para criar bloqueio.");
        return;
      }

      await api.post("/admin/agenda/bloqueios", {
        quadraId: quadraIdAlvo,
        data,
        horaInicio,
        horaFim,
        motivo,
      });

      setMensagem("Bloqueio criado com sucesso.");
      resetBloqueioForm();
      carregarAgendaDaQuadra(quadraSelecionadaId);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao salvar bloqueio:", err);
      setErroAgenda(err.response?.data?.error || "Erro ao salvar bloqueio.");
    } finally {
      setSalvandoBloqueio(false);
    }
  }

  async function excluirBloqueio(bloqueioId) {
    try {
      setExcluindoBloqueioId(bloqueioId);
      setMensagem("");
      setErroAgenda("");

      await api.delete(`/admin/agenda/bloqueios/${bloqueioId}`);
      setMensagem("Bloqueio excluído.");
      carregarAgendaDaQuadra(quadraSelecionadaId);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao excluir bloqueio:", err);
      setErroAgenda(err.response?.data?.error || "Erro ao excluir bloqueio.");
    } finally {
      setExcluindoBloqueioId(null);
    }
  }

  // -----------------------------------
  // 6) Slots (cinema) (ADMIN)
  // -----------------------------------
  async function buscarSlots({ quadraId, periodo, dataInicio, dataFim, filtro }) {
    const { data } = await api.get("/admin/agenda/slots", {
      params: { quadraId, periodo, dataInicio, dataFim, filtro },
    });
    return data;
  }

  const podeMostrarCinema = useMemo(() => !!quadraSelecionadaId, [quadraSelecionadaId]);

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 className="page-title">Agenda (Admin)</h1>
          <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
            Clone total do módulo Agenda do Gestor — Admin tem visão e permissão global.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-outline-secondary" onClick={carregarEmpresas} disabled={carregandoEmpresas}>
            {carregandoEmpresas ? "Recarregando..." : "Recarregar bases"}
          </button>

          <Link className="btn btn-primary" to="/admin/agenda/editar">
            Avançado (regras + bloqueios)
          </Link>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        {carregandoEmpresas && <p>Carregando empresas.</p>}

        {erroEmpresas && !carregandoEmpresas && <p className="form-message error">{erroEmpresas}</p>}

        {!carregandoEmpresas && !erroEmpresas && empresas.length === 0 && (
          <p>Nenhuma empresa/complexo encontrada. Cadastre uma empresa primeiro.</p>
        )}

        {!carregandoEmpresas && empresas.length > 0 && (
          <div className="form-grid" style={{ maxWidth: 700 }}>
            <div className="form-field form-field-full">
              <label htmlFor="empresaSelecionada">Empresa / Complexo</label>
              <select id="empresaSelecionada" value={empresaSelecionadaId} onChange={handleSelecionarEmpresa}>
                <option value="">Selecione uma empresa</option>
                {empresas.map((empresa) => (
                  <option key={empresa.id} value={empresa.id}>
                    {formatarNomeEmpresa(empresa)}
                  </option>
                ))}
              </select>
              <small>Admin: escolha qualquer complexo para ver as quadras vinculadas.</small>
            </div>

            {empresaSelecionadaId && (
              <div className="form-field form-field-full">
                <label htmlFor="quadraSelecionada">Quadra (visualização)</label>

                {carregandoQuadras && <p>Carregando quadras.</p>}

                {erroQuadras && !carregandoQuadras && <p className="form-message error">{erroQuadras}</p>}

                {!carregandoQuadras && !erroQuadras && quadras.length === 0 && (
                  <p>Nenhuma quadra cadastrada para este complexo.</p>
                )}

                {!carregandoQuadras && quadras.length > 0 && (
                  <>
                    <select id="quadraSelecionada" value={quadraSelecionadaId} onChange={handleSelecionarQuadra}>
                      <option value="">Selecione uma quadra</option>
                      {quadras.map((q) => (
                        <option key={q.id} value={q.id}>
                          {formatarNomeQuadra(q)}
                        </option>
                      ))}
                    </select>
                    <small>
                      Esta quadra será usada para exibir a agenda abaixo. A criação de regras e bloqueios pode ser
                      aplicada em lote a várias quadras (Admin).
                    </small>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {erroAgenda && (
        <div
          className="alert-erro-agenda"
          style={{
            marginTop: 16,
            marginBottom: 16,
            padding: "12px 16px",
            borderRadius: 8,
            border: "1px solid #fca5a5",
            backgroundColor: "#fee2e2",
            color: "#b91c1c",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>⚠️</span>
          <div>
            <strong style={{ display: "block", marginBottom: 2 }}>Atenção</strong>
            <div>{erroAgenda}</div>
          </div>
        </div>
      )}

      {mensagem && <div className="alert-sucesso">{mensagem}</div>}

      {podeMostrarCinema && (
        <div style={{ marginTop: 12 }}>
          <AgendaFilters
            periodo={periodo}
            setPeriodo={setPeriodo}
            filtroStatus={filtroStatus}
            setFiltroStatus={setFiltroStatus}
            dataInicio={dataInicio}
            setDataInicio={setDataInicio}
            dataFim={dataFim}
            setDataFim={setDataFim}
          />

          <AgendaCinemaView
            quadraId={quadraSelecionadaId}
            periodo={periodo}
            filtro={filtroStatus}
            dataInicio={dataInicio}
            dataFim={dataFim}
            buscarSlots={buscarSlots}
          />
        </div>
      )}

      {/* Boxes (mesmo layout do Gestor) */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <AgendaRegrasBox
          regras={regras}
          quadras={quadras}
          quadraSelecionadaId={quadraSelecionadaId}
          selectedQuadraIds={selectedQuadraIds}
          setSelectedQuadraIds={setSelectedQuadraIds}
          diasSelecionados={diasSelecionados}
          setDiasSelecionados={setDiasSelecionados}
          regraForm={regraForm}
          setRegraForm={setRegraForm}
          regraEditandoId={regraEditandoId}
          setRegraEditandoId={setRegraEditandoId}
          setEditingQuadraId={setEditingQuadraId}
          salvandoRegra={salvandoRegra}
          excluindoRegraId={excluindoRegraId}
          onSalvarRegra={salvarRegra}
          onExcluirRegra={excluirRegra}
          onAplicarLote={aplicarRegrasEmLote}
          onResetForm={resetRegraForm}
        />

        <AgendaBloqueiosBox
          bloqueios={bloqueios}
          quadras={quadras}
          quadraSelecionadaId={quadraSelecionadaId}
          selectedQuadraIds={selectedQuadraIds}
          setSelectedQuadraIds={setSelectedQuadraIds}
          bloquearComplexoInteiro={bloquearComplexoInteiro}
          setBloquearComplexoInteiro={setBloquearComplexoInteiro}
          bloqueioForm={bloqueioForm}
          setBloqueioForm={setBloqueioForm}
          salvandoBloqueio={salvandoBloqueio}
          excluindoBloqueioId={excluindoBloqueioId}
          onSalvarBloqueio={salvarBloqueio}
          onExcluirBloqueio={excluirBloqueio}
          onResetForm={resetBloqueioForm}
        />
      </div>
    </div>
  );
}

export default AdminAgendaPage;
