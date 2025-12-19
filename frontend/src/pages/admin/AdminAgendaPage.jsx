// src/pages/admin/AdminAgendaPage.jsx
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";

// ⚠️ IMPORTS DA AGENDA – todos vindos de src/components/agenda
import { AgendaFilters } from "../../components/agenda/AgendaFilters";
import { AgendaLegend } from "../../components/agenda/AgendaLegend";
import { AgendaGrid } from "../../components/agenda/AgendaGrid";

// Aqui eu vou assumir que seu arquivo exporta **default**
// src/components/agenda/gestor/agendacinemaview.jsx
import AgendaCinemaView from "../../components/gestor/AgendaCinemaView";
import AgendaCinemaViewReal from "../../components/gestor/AgendaCinemaViewReal";


import { AgendaToolbar } from "../../components/agenda/AgendaToolbar";


function AdminAgendaPage() {
  const { usuario } = useAuth();

  const [empresas, setEmpresas] = useState([]);
  const [empresaSelecionadaId, setEmpresaSelecionadaId] = useState("");

  const [quadras, setQuadras] = useState([]);
  const [quadraSelecionadaId, setQuadraSelecionadaId] = useState("");

  const [regras, setRegras] = useState([]);
  const [bloqueios, setBloqueios] = useState([]);

  const [carregandoEmpresas, setCarregandoEmpresas] = useState(false);
  const [carregandoQuadras, setCarregandoQuadras] = useState(false);
  const [carregandoAgenda, setCarregandoAgenda] = useState(false);

  const [erroEmpresas, setErroEmpresas] = useState("");
  const [erroQuadras, setErroQuadras] = useState("");
  const [erroAgenda, setErroAgenda] = useState("");

  // ✅ mensagem de sucesso/avisos gerais da agenda
  const [mensagem, setMensagem] = useState("");

  const [periodo, setPeriodo] = useState("semana");
  const [filtroStatus, setFiltroStatus] = useState("todas");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");

  // Form de regra
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
  const [bloquearComplexoInteiro, setBloquearComplexoInteiro] =
    useState(false);
  const [salvandoBloqueio, setSalvandoBloqueio] = useState(false);
  const [excluindoBloqueioId, setExcluindoBloqueioId] = useState(null);

  // -----------------------------------
  // 1) Carregar empresas do Admin
  // -----------------------------------
  async function carregarEmpresas() {
    try {
      setCarregandoEmpresas(true);
      setErroEmpresas("");
      setMensagem("");

      const { data } = await api.get("/admin/empresas");
      setEmpresas(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao buscar empresas:", err);
      const mensagemLocal =
        err.response?.data?.error ||
        "Erro ao carregar empresas. Tente novamente mais tarde.";
      setErroEmpresas(mensagemLocal);
    } finally {
      setCarregandoEmpresas(false);
    }
  }

  useEffect(() => {
    if (!usuario) return;
    carregarEmpresas();
  }, [usuario]);

  // -----------------------------------
  // 2) Carregar quadras da empresa selecionada
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

      const { data } = await api.get("/admin/quadras", {
        params: { empresaId },
      });

      const lista = Array.isArray(data) ? data : [];
      setQuadras(lista);

      if (lista.length === 0) {
        setQuadraSelecionadaId("");
        setSelectedQuadraIds([]);
      }
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao buscar quadras:", err);
      const mensagemLocal =
        err.response?.data?.error ||
        "Erro ao carregar quadras da empresa selecionada.";
      setErroQuadras(mensagemLocal);
      setQuadras([]);
      setQuadraSelecionadaId("");
      setSelectedQuadraIds([]);
    } finally {
      setCarregandoQuadras(false);
    }
  }

  function handleSelecionarEmpresa(event) {
    const id = event.target.value;
    setEmpresaSelecionadaId(id);

    setQuadras([]);
    setQuadraSelecionadaId("");
    setSelectedQuadraIds([]);
    setRegras([]);
    setBloqueios([]);
    setErroAgenda("");
    setMensagem("");
    setRegraEditandoId(null);
    setEditingQuadraId(null);
    setDiasSelecionados([]);
    resetRegraForm();
    resetBloqueioForm();
    setBloquearComplexoInteiro(false);

    if (id) {
      carregarQuadrasDaEmpresa(id);
    }
  }

  // Quando muda a quadra selecionada (visão), alinhar com lista de quadras marcadas
  useEffect(() => {
    if (quadraSelecionadaId) {
      setSelectedQuadraIds([quadraSelecionadaId]);
    } else {
      setSelectedQuadraIds([]);
    }
  }, [quadraSelecionadaId]);

  // -----------------------------------
  // 3) Buscar regras e bloqueios da quadra
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
        api.get("/admin/agenda/regras", {
          params: { quadraId },
        }),
        api.get("/admin/agenda/bloqueios", {
          params: { quadraId },
        }),
      ]);

      setRegras(respRegras.data?.regras || []);
      setBloqueios(respBloqueios.data?.bloqueios || []);
    } catch (err) {
      console.error("[GESTOR/AGENDA] Erro ao buscar agenda:", err);
      const mensagemLocal =
        err.response?.data?.error ||
        "Erro ao carregar regras/bloqueios da quadra.";
      setErroAgenda(mensagemLocal);
      setRegras([]);
      setBloqueios([]);
    } finally {
      setCarregandoAgenda(false);
    }
  }

  function handleSelecionarQuadra(event) {
    const id = event.target.value;
    setQuadraSelecionadaId(id);
    setRegras([]);
    setBloqueios([]);
    setErroAgenda("");
    setMensagem("");
    setRegraEditandoId(null);
    setEditingQuadraId(null);
    setDiasSelecionados([]);
    resetRegraForm();
    resetBloqueioForm();
    setBloquearComplexoInteiro(false);

    if (id) {
      carregarAgendaDaQuadra(id);
    }
  }

  // -----------------------------------
  // Helpers de form
  // -----------------------------------
  function resetRegraForm() {
    setRegraForm({
      diaSemana: "",
      horaInicio: "",
      horaFim: "",
      precoHora: "",
      ativo: true,
    });
    setRegraEditandoId(null);
    setEditingQuadraId(null);
    setDiasSelecionados([]);
    setSelectedQuadraIds(quadraSelecionadaId ? [quadraSelecionadaId] : []);
  }

  function resetBloqueioForm() {
    setBloqueioForm({
      data: "",
      horaInicio: "",
      horaFim: "",
      motivo: "",
    });
    // não mexe em bloquearComplexoInteiro aqui
  }

  function handleChangeRegraForm(event) {
    const { name, value, type, checked } = event.target;
    setRegraForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  function handleChangeBloqueioForm(event) {
    const { name, value } = event.target;
    setBloqueioForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  }

  function toggleQuadraSelecionada(id) {
    setSelectedQuadraIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((qId) => qId !== id);
      }
      return [...prev, id];
    });
  }

  function toggleDiaSelecionado(valorDia) {
    setDiasSelecionados((prev) => {
      if (prev.includes(valorDia)) {
        return prev.filter((d) => d !== valorDia);
      }
      return [...prev, valorDia];
    });
  }

  // -----------------------------------
  // Ações de Regras
  // -----------------------------------
  async function handleSubmitRegra(event) {
    event.preventDefault();

    if (!quadraSelecionadaId) {
      setErroAgenda("Selecione uma quadra para visualizar a agenda.");
      setMensagem("");
      return;
    }

    if (!regraForm.horaInicio || !regraForm.horaFim) {
      setErroAgenda("Informe horário de início e fim.");
      setMensagem("");
      return;
    }

    try {
      setSalvandoRegra(true);
      setErroAgenda("");
      // 🔹 zera mensagem de sucesso antes de tentar salvar
      setMensagem("");

      if (regraEditandoId) {
        // EDIÇÃO de uma regra específica
        if (regraForm.diaSemana === "" && regraForm.diaSemana !== 0) {
          setErroAgenda(
            "Informe o dia da semana para salvar a alteração da regra."
          );
          setSalvandoRegra(false);
          return;
        }

        const payload = {
          quadraId: editingQuadraId || quadraSelecionadaId,
          diaSemana: Number(regraForm.diaSemana),
          horaInicio: regraForm.horaInicio,
          horaFim: regraForm.horaFim,
          precoHora:
            regraForm.precoHora === ""
              ? null
              : Number(String(regraForm.precoHora).replace(",", ".")),
          ativo: regraForm.ativo,
        };

        await api.put(`/admin/agenda/regras/${regraEditandoId}`, payload);
      } else {
        // CRIAÇÃO EM LOTE
        if (!selectedQuadraIds.length) {
          setErroAgenda(
            "Selecione pelo menos uma quadra na lista de quadras para aplicar a regra."
          );
          setSalvandoRegra(false);
          return;
        }

        if (!diasSelecionados.length) {
          setErroAgenda(
            "Selecione pelo menos um dia da semana para aplicar a regra."
          );
          setSalvandoRegra(false);
          return;
        }

        const payload = {
          quadraIds: selectedQuadraIds,
          diasSemana: diasSelecionados,
          horaInicio: regraForm.horaInicio,
          horaFim: regraForm.horaFim,
          precoHora:
            regraForm.precoHora === ""
              ? null
              : Number(String(regraForm.precoHora).replace(",", ".")),
          ativo: regraForm.ativo,
        };

        await api.post("/admin/agenda/regras/lote", payload);
      }

      await carregarAgendaDaQuadra(quadraSelecionadaId);
      resetRegraForm();

      // ✅ Mensagens de sucesso
      if (regraEditandoId) {
        setMensagem("Regra de horário atualizada com sucesso.");
      } else {
        setMensagem("Regras de horário criadas com sucesso.");
      }
    } catch (err) {
      console.error("[GESTOR/AGENDA] Erro ao salvar regra:", err);

      const status = err.response?.status;
      const apiError = err.response?.data?.error;

      let mensagemLocal = "Erro ao salvar regra de horário.";

      if (status === 409) {
        // Conflito: regra já existe para esse dia/horário
        mensagemLocal =
          apiError ||
          "Já existe regra cobrindo esses horários para alguma das quadras selecionadas. " +
            "Use a tela de edição para alterar preço, horário ou excluir.";
      } else if (apiError) {
        mensagemLocal = apiError;
      }

      setErroAgenda(mensagemLocal);
      setMensagem("");
    } finally {
      setSalvandoRegra(false);
    }
  }

  function iniciarEdicaoRegra(regra) {
    setRegraEditandoId(regra.id);
    setEditingQuadraId(regra.quadra_id);
    setRegraForm({
      diaSemana: regra.dia_semana,
      horaInicio: regra.hora_inicio,
      horaFim: regra.hora_fim,
      precoHora: regra.preco_hora ?? "",
      ativo: !!regra.ativo,
    });
    setDiasSelecionados([]);
    setSelectedQuadraIds([regra.quadra_id]);
    setMensagem("");
    setErroAgenda("");
  }

  async function handleExcluirRegra(regraId) {
    if (!quadraSelecionadaId) return;

    const confirmar = window.confirm(
      "Tem certeza que deseja desativar esta regra?"
    );
    if (!confirmar) return;

    try {
      setExcluindoRegraId(regraId);
      setErroAgenda("");
      setMensagem("");

      await api.delete(`/admin/agenda/regras/${regraId}`, {
        data: { quadraId: quadraSelecionadaId, softDelete: true },
      });

      await carregarAgendaDaQuadra(quadraSelecionadaId);
      setMensagem("Regra desativada com sucesso.");
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao excluir regra:", err);
      const mensagemLocal =
        err.response?.data?.error || "Erro ao excluir regra de horário.";
      setErroAgenda(mensagemLocal);
      setMensagem("");
    } finally {
      setExcluindoRegraId(null);
    }
  }

  // -----------------------------------
  // Ações de Bloqueios (LOTE + COMPLEXO INTEIRO)
  // -----------------------------------
  async function handleSubmitBloqueio(event) {
    event.preventDefault();

    if (!empresaSelecionadaId) {
      setErroAgenda(
        "Selecione um complexo/empresa antes de criar bloqueios."
      );
      setMensagem("");
      return;
    }

    if (!bloqueioForm.data || !bloqueioForm.horaInicio || !bloqueioForm.horaFim) {
      setErroAgenda("Informe data, hora de início e fim para o bloqueio.");
      setMensagem("");
      return;
    }

    // Define quais quadras vão receber o bloqueio
    let quadrasAlvo = [];

    if (bloquearComplexoInteiro) {
      quadrasAlvo = quadras.map((q) => q.id);
    } else if (selectedQuadraIds.length > 0) {
      quadrasAlvo = [...selectedQuadraIds];
    } else if (quadraSelecionadaId) {
      quadrasAlvo = [quadraSelecionadaId];
    }

    quadrasAlvo = Array.from(new Set(quadrasAlvo));

    if (!quadrasAlvo.length) {
      setErroAgenda(
        "Selecione pelo menos uma quadra ou marque 'Bloquear complexo inteiro'."
      );
      setMensagem("");
      return;
    }

    try {
      setSalvandoBloqueio(true);
      setErroAgenda("");
      setMensagem("");

      const payload = {
        quadraIds: quadrasAlvo,
        data: bloqueioForm.data,
        horaInicio: bloqueioForm.horaInicio,
        horaFim: bloqueioForm.horaFim,
        motivo:
          bloqueioForm.motivo ||
          (bloquearComplexoInteiro
            ? "Bloqueio geral do complexo"
            : "Bloqueio manual"),
      };

      await api.post("/admin/agenda/bloqueios/lote", payload);

      if (quadraSelecionadaId) {
        await carregarAgendaDaQuadra(quadraSelecionadaId);
      }

      resetBloqueioForm();
      setMensagem("Bloqueio(s) cadastrado(s) com sucesso.");
    } catch (err) {
      console.error("[GESTOR/AGENDA] Erro ao salvar bloqueio:", err);
      const mensagemLocal =
        err.response?.data?.error || "Erro ao salvar bloqueio da quadra.";
      setErroAgenda(mensagemLocal);
      setMensagem("");
    } finally {
      setSalvandoBloqueio(false);
    }
  }

  async function handleExcluirBloqueio(bloqueioId) {
    if (!quadraSelecionadaId) return;

    const confirmar = window.confirm(
      "Tem certeza que deseja remover este bloqueio?"
    );
    if (!confirmar) return;

    try {
      setExcluindoBloqueioId(bloqueioId);
      setErroAgenda("");
      setMensagem("");

      await api.delete(`/admin/agenda/bloqueios/${bloqueioId}`, {
        data: { quadraId: quadraSelecionadaId },
      });

      await carregarAgendaDaQuadra(quadraSelecionadaId);
      setMensagem("Bloqueio removido com sucesso.");
    } catch (err) {
      console.error("[ADMIN/AGENDA] Erro ao excluir bloqueio:", err);
      const mensagemLocal =
        err.response?.data?.error || "Erro ao excluir bloqueio da quadra.";
      setErroAgenda(mensagemLocal);
      setMensagem("");
    } finally {
      setExcluindoBloqueioId(null);
    }
  }

  // -----------------------------------
  // Helpers de exibição
  // -----------------------------------
  function formatarNomeEmpresa(empresa) {
    const nome = empresa.nome || "Sem nome";
    const desc = empresa.descricao_complexo;
    if (desc) {
      return `${nome} — ${desc}`;
    }
    return nome;
  }

  function formatarNomeQuadra(quadra) {
    const tipo = quadra.tipo || "Tipo";
    const material = quadra.material || "Material";
    const modalidade = quadra.modalidade || "Modalidade";
    return `${modalidade} - ${material} (${tipo})`;
  }

  function labelDiaSemana(numero) {
    const mapa = {
      0: "Domingo",
      1: "Segunda",
      2: "Terça",
      3: "Quarta",
      4: "Quinta",
      5: "Sexta",
      6: "Sábado",
    };
    return mapa[numero] ?? numero;
  }

  // -----------------------------------
  // RENDER
  // -----------------------------------
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Agenda das Quadras (Admin)</h1>

        {/* 🔹 Botão para abrir a tela de edição organizada */}
        <Link to="/admin/agenda/editar" className="btn-outlined">
          Editar agenda
        </Link>
      </div>

      <p style={{ marginBottom: 16 }}>
        Primeiro selecione o <strong>complexo/empresa</strong>, depois escolha a{" "}
        <strong>quadra</strong> para visualizar a agenda. No formulário de
        regras você pode aplicar a mesma faixa de horário/valor para{" "}
        <strong>várias quadras</strong> e vários dias. Em bloqueios, você pode
        bloquear quadras específicas ou o{" "}
        <strong>complexo inteiro (ex.: Natal/Ano Novo)</strong>.
      </p>

      {/* ✅ Alerta de SUCESSO/AVISO */}
      {mensagem && (
        <div
          className="alert-sucesso-agenda"
          style={{
            marginTop: 8,
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #4ade80",
            backgroundColor: "#ecfdf3",
            color: "#166534",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>✅</span>
          <div>
            <strong style={{ display: "block", marginBottom: 4 }}>
              Operação concluída
            </strong>
            <span>{mensagem}</span>
          </div>
        </div>
      )}

      {/* Seleção da Empresa e Quadra */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Seleção de complexo e quadra</h3>

        {/* Empresas */}
        {carregandoEmpresas && <p>Carregando empresas do gestor...</p>}

        {erroEmpresas && !carregandoEmpresas && (
          <p className="form-message error">{erroEmpresas}</p>
        )}

        {!carregandoEmpresas && !erroEmpresas && empresas.length === 0 && (
          <p>
            Nenhuma empresa/complexo encontrada para este gestor. Cadastre uma
            empresa primeiro.
          </p>
        )}

        {!carregandoEmpresas && empresas.length > 0 && (
          <div className="form-grid" style={{ maxWidth: 700 }}>
            <div className="form-field form-field-full">
              <label htmlFor="empresaSelecionada">Empresa / Complexo</label>
              <select
                id="empresaSelecionada"
                value={empresaSelecionadaId}
                onChange={handleSelecionarEmpresa}
              >
                <option value="">Selecione uma empresa</option>
                {empresas.map((empresa) => (
                  <option key={empresa.id} value={empresa.id}>
                    {formatarNomeEmpresa(empresa)}
                  </option>
                ))}
              </select>
              <small>
                Escolha o complexo para ver apenas as quadras vinculadas a ele.
              </small>
            </div>

            {/* Quadras da empresa */}
            {empresaSelecionadaId && (
              <div className="form-field form-field-full">
                <label htmlFor="quadraSelecionada">Quadra (visualização)</label>
                {carregandoQuadras && <p>Carregando quadras...</p>}

                {erroQuadras && !carregandoQuadras && (
                  <p className="form-message error">{erroQuadras}</p>
                )}

                {!carregandoQuadras &&
                  !erroQuadras &&
                  quadras.length === 0 && (
                    <p>Nenhuma quadra cadastrada para este complexo.</p>
                  )}

                {!carregandoQuadras && quadras.length > 0 && (
                  <>
                    <select
                      id="quadraSelecionada"
                      value={quadraSelecionadaId}
                      onChange={handleSelecionarQuadra}
                    >
                      <option value="">Selecione uma quadra</option>
                      {quadras.map((q) => (
                        <option key={q.id} value={q.id}>
                          {formatarNomeQuadra(q)}
                        </option>
                      ))}
                    </select>
                    <small>
                      Esta quadra será usada para exibir a agenda abaixo. A
                      criação de regras e bloqueios pode ser aplicada em lote a
                      várias quadras.
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
            backgroundColor: "#fee2e2", // fundo vermelho claro
            color: "#b91c1c", // texto vermelho forte
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>⚠️</span>
          <div>
            <strong style={{ display: "block", marginBottom: 4 }}>
              Atenção na agenda
            </strong>
            <span>{erroAgenda}</span>
          </div>
        </div>
      )}
      {/* VISÃO CINEMA DA AGENDA (ADMIN = GESTOR) */}
{quadraSelecionadaId && (
  <AgendaCinemaViewReal
    quadraId={quadraSelecionadaId}
    mode="ADMIN"
  />
)}

      {/* Painéis de Regras e Bloqueios */}
      {quadraSelecionadaId && (
        <div
          className="page-grid"
          style={{ display: "grid", gap: 16, gridTemplateColumns: "1.2fr 1fr" }}
        >
          {/* REGRAS DE HORÁRIO */}
          <div className="card">
            <h3>Regras de horário da quadra</h3>

            {/* Form de criação/edição de regra */}
            <form
              className="form-grid"
              style={{ marginTop: 8, marginBottom: 12 }}
              onSubmit={handleSubmitRegra}
            >
              {/* Seleção de quadras para aplicar esta regra (lote) */}
              <div className="form-field form-field-full">
                <label>Quadras para aplicar esta regra (lote)</label>
                {quadras.length === 0 && (
                  <p style={{ fontSize: 13 }}>
                    Nenhuma quadra cadastrada para este complexo.
                  </p>
                )}
                {quadras.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    {quadras.map((q) => (
                      <label
                        key={q.id}
                        style={{ fontSize: 13, display: "flex", gap: 4 }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedQuadraIds.includes(q.id)}
                          onChange={() => toggleQuadraSelecionada(q.id)}
                        />
                        {formatarNomeQuadra(q)}
                      </label>
                    ))}
                  </div>
                )}
                <small>
                  Ao criar uma nova regra, todas as quadras marcadas receberão a
                  mesma faixa de horário/valor. Ao editar uma regra na tabela,
                  apenas aquela quadra e dia serão alterados.
                </small>
              </div>

              {/* Campo diaSemana (edição) */}
              <div className="form-field">
                <label htmlFor="diaSemana">
                  Dia da semana{" "}
                  <span style={{ fontSize: 11, fontWeight: "normal" }}>
                    (usado para edição de regra individual)
                  </span>
                </label>
                <select
                  id="diaSemana"
                  name="diaSemana"
                  value={regraForm.diaSemana}
                  onChange={handleChangeRegraForm}
                >
                  <option value="">Selecione</option>
                  <option value={1}>Segunda</option>
                  <option value={2}>Terça</option>
                  <option value={3}>Quarta</option>
                  <option value={4}>Quinta</option>
                  <option value={5}>Sexta</option>
                  <option value={6}>Sábado</option>
                  <option value={0}>Domingo</option>
                </select>
                <small>
                  Ao <strong>editar</strong> uma regra existente, esse campo
                  será preenchido automaticamente. Para criar novas regras em
                  lote, use os checkboxes de dias abaixo.
                </small>
              </div>

              {/* Checkboxes de dias para criação em lote */}
              <div className="form-field form-field-full">
                <label>Dias da semana para nova regra (lote)</label>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  {[
                    { valor: 1, label: "Seg" },
                    { valor: 2, label: "Ter" },
                    { valor: 3, label: "Qua" },
                    { valor: 4, label: "Qui" },
                    { valor: 5, label: "Sex" },
                    { valor: 6, label: "Sáb" },
                    { valor: 0, label: "Dom" },
                  ].map((dia) => (
                    <label
                      key={dia.valor}
                      style={{ fontSize: 13, display: "flex", gap: 4 }}
                    >
                      <input
                        type="checkbox"
                        checked={diasSelecionados.includes(dia.valor)}
                        onChange={() => toggleDiaSelecionado(dia.valor)}
                      />
                      {dia.label}
                    </label>
                  ))}
                </div>
                <small>
                  Para <strong>criar novas regras</strong> em lote, selecione
                  aqui os dias que terão a mesma faixa de horário e valor.
                </small>
              </div>

              <div className="form-field">
                <label htmlFor="horaInicio">Hora início</label>
                <input
                  type="time"
                  id="horaInicio"
                  name="horaInicio"
                  value={regraForm.horaInicio}
                  onChange={handleChangeRegraForm}
                />
              </div>

              <div className="form-field">
                <label htmlFor="horaFim">Hora fim</label>
                <input
                  type="time"
                  id="horaFim"
                  name="horaFim"
                  value={regraForm.horaFim}
                  onChange={handleChangeRegraForm}
                />
              </div>

              <div className="form-field">
                <label htmlFor="precoHora">Preço por hora (R$)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  id="precoHora"
                  name="precoHora"
                  value={regraForm.precoHora}
                  onChange={handleChangeRegraForm}
                />
              </div>

              <div className="form-field">
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    name="ativo"
                    checked={regraForm.ativo}
                    onChange={handleChangeRegraForm}
                  />
                  Regra ativa
                </label>
              </div>

              <div className="form-actions">
                {regraEditandoId && (
                  <button
                    type="button"
                    className="btn-outlined"
                    onClick={resetRegraForm}
                    disabled={salvandoRegra}
                  >
                    Cancelar edição
                  </button>
                )}
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={salvandoRegra}
                >
                  {salvandoRegra
                    ? "Salvando..."
                    : regraEditandoId
                    ? "Salvar alterações"
                    : "Adicionar regra em lote"}
                </button>
              </div>
            </form>

            {carregandoAgenda && <p>Carregando regras...</p>}

            {!carregandoAgenda && regras.length === 0 && (
              <p>Nenhuma regra cadastrada para esta quadra ainda.</p>
            )}

            {!carregandoAgenda && regras.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table
                  className="tabela-simples"
                  style={{ width: "100%", minWidth: 650 }}
                >
                  <thead>
                    <tr>
                      <th>Dia</th>
                      <th>Início</th>
                      <th>Fim</th>
                      <th>Preço/hora</th>
                      <th>Ativo</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regras.map((regra) => (
                      <tr key={regra.id}>
                        <td>{labelDiaSemana(regra.dia_semana)}</td>
                        <td>{regra.hora_inicio}</td>
                        <td>{regra.hora_fim}</td>
                        <td>
                          {regra.preco_hora != null
                            ? `R$ ${Number(regra.preco_hora).toFixed(2)}`
                            : "-"}
                        </td>
                        <td>{regra.ativo ? "Sim" : "Não"}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-outlined"
                            style={{ marginRight: 6 }}
                            onClick={() => iniciarEdicaoRegra(regra)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleExcluirRegra(regra.id)}
                            disabled={excluindoRegraId === regra.id}
                          >
                            {excluindoRegraId === regra.id
                              ? "Removendo..."
                              : "Desativar"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* BLOQUEIOS MANUAIS */}
          <div className="card">
            <h3>Bloqueios manuais da quadra</h3>

            {/* Form de criação de bloqueio (lote + complexo inteiro) */}
            <form
              className="form-grid"
              style={{ marginTop: 8, marginBottom: 12 }}
              onSubmit={handleSubmitBloqueio}
            >
              {/* Escopo do bloqueio */}
              <div className="form-field form-field-full">
                <label>Escopo do bloqueio</label>
                <label
                  style={{
                    fontSize: 13,
                    display: "flex",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={bloquearComplexoInteiro}
                    onChange={(e) =>
                      setBloquearComplexoInteiro(e.target.checked)
                    }
                  />
                  Bloquear complexo inteiro (todas as quadras deste complexo)
                </label>
                <small>
                  Se <strong>não</strong> marcar essa opção, o bloqueio será
                  aplicado às quadras marcadas na lista de quadras (acima). Se
                  nenhuma quadra estiver marcada, será usada apenas a{" "}
                  <strong>quadra selecionada</strong>.
                </small>
              </div>

              <div className="form-field">
                <label htmlFor="dataBloqueio">Data</label>
                <input
                  type="date"
                  id="dataBloqueio"
                  name="data"
                  value={bloqueioForm.data}
                  onChange={handleChangeBloqueioForm}
                />
              </div>

              <div className="form-field">
                <label htmlFor="horaInicioBloqueio">Hora início</label>
                <input
                  type="time"
                  id="horaInicioBloqueio"
                  name="horaInicio"
                  value={bloqueioForm.horaInicio}
                  onChange={handleChangeBloqueioForm}
                />
              </div>

              <div className="form-field">
                <label htmlFor="horaFimBloqueio">Hora fim</label>
                <input
                  type="time"
                  id="horaFimBloqueio"
                  name="horaFim"
                  value={bloqueioForm.horaFim}
                  onChange={handleChangeBloqueioForm}
                />
              </div>

              <div className="form-field form-field-full">
                <label htmlFor="motivoBloqueio">Motivo (opcional)</label>
                <input
                  type="text"
                  id="motivoBloqueio"
                  name="motivo"
                  placeholder="Ex.: Natal, Ano Novo, campeonato, manutenção..."
                  value={bloqueioForm.motivo}
                  onChange={handleChangeBloqueioForm}
                />
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="btn-outlined"
                  onClick={resetBloqueioForm}
                  disabled={salvandoBloqueio}
                >
                  Limpar
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={salvandoBloqueio}
                >
                  {salvandoBloqueio
                    ? "Salvando..."
                    : "Adicionar bloqueio (lote)"}
                </button>
              </div>
            </form>

            {carregandoAgenda && <p>Carregando bloqueios...</p>}

            {!carregandoAgenda && bloqueios.length === 0 && (
              <p>Nenhum bloqueio manual cadastrado para esta quadra.</p>
            )}

            {!carregandoAgenda && bloqueios.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table
                  className="tabela-simples"
                  style={{ width: "100%", minWidth: 520 }}
                >
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Início</th>
                      <th>Fim</th>
                      <th>Motivo</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bloqueios.map((b) => (
                      <tr key={b.id}>
                        <td>{b.data}</td>
                        <td>{b.hora_inicio}</td>
                        <td>{b.hora_fim}</td>
                        <td>{b.motivo || "-"}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleExcluirBloqueio(b.id)}
                            disabled={excluindoBloqueioId === b.id}
                          >
                            {excluindoBloqueioId === b.id
                              ? "Removendo..."
                              : "Remover"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
              <em>
                Use bloqueios para marcar horários indisponíveis fora do
                VaiTerPlay (ex.: feriados, reservas presenciais, eventos,
                manutenção). Para feriados como Natal/Ano Novo, use “Bloquear
                complexo inteiro”.
              </em>
            </p>
          </div>
        </div>
      )}

      {!quadraSelecionadaId && empresaSelecionadaId && (
        <p style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
          Selecione uma quadra para visualizar e configurar a agenda.
        </p>
      )}

      {!empresaSelecionadaId && (
        <p style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
          Selecione um complexo/empresa acima para começar.
        </p>
      )}
    </div>
  );
}

export default AdminAgendaPage;
