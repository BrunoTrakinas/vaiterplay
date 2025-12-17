import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

// =====================================================
// AdminReservasPage.jsx
// - Visual idêntico ao Gestor (cinema) + visão global (filtros/listagem)
// - Admin vê tudo e pode criar/editar/cancelar
// - Reservas criadas no painel entram como PAID (padrão do projeto)
// =====================================================

const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function formatNomeQuadra(q) {
  if (!q) return "—";
  // backend /admin/quadras já devolve nome_dinamico? (se não, cai no fallback)
  return (
    q.nome_dinamico ||
    q.nome ||
    `${q.tipo || "Quadra"}${q.material ? ` • ${q.material}` : ""}${
      q.modalidade ? ` • ${q.modalidade}` : ""
    }`
  );
}

function statusLabel(s) {
  const v = String(s || "").toLowerCase();
  if (v === "paid") return { t: "PAGO", cls: "badge bg-success" };
  if (v === "pending") return { t: "PENDENTE", cls: "badge bg-warning text-dark" };
  if (v === "canceled") return { t: "CANCELADO", cls: "badge bg-secondary" };
  return { t: (s || "—").toUpperCase(), cls: "badge bg-light text-dark" };
}

function origemLabel(o) {
  const v = String(o || "").toLowerCase();
  if (v === "whatsapp") return { t: "WHATSAPP/PIX", cls: "badge bg-info text-dark" };
  if (v === "painel") return { t: "PAINEL", cls: "badge bg-dark" };
  return { t: (o || "—").toUpperCase(), cls: "badge bg-light text-dark" };
}

// =====================================================
// MODAL: CRIAR RESERVA (ADMIN)
// =====================================================
function CriarReservaModal({ aberto, onFechar, quadraId, quadraNome, onCriada, dataSug, horaSug }) {
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
   
  useEffect(() => {
    if (!aberto) return;
    setErro("");
    setCpf("");
    setPhone("");
    setValor("");
    if (dataSug) setData(String(dataSug).slice(0, 10));
    if (horaSug) setHora(String(horaSug).slice(0, 5));
  }, [aberto, dataSug, horaSug]);

  if (!aberto) return null;

  const salvar = async () => {
    try {
      setSalvando(true);
      setErro("");
      if (!quadraId) return setErro("Selecione uma quadra.");
      if (!data || !hora) return setErro("Informe data e hora.");

      const body = {
        quadraId,
        data,
        hora: hora.length >= 5 ? hora.slice(0, 5) : hora,
        cpf: cpf || null,
        phone: phone || null,
        preco_total: valor !== "" ? Number(valor) : 0,
      };

      await api.post("/admin/reservas", body);
      if (onCriada) onCriada();
      onFechar();
    } catch (e) {
      const msg = e?.response?.data?.error || "Erro ao criar reserva.";
      setErro(msg);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="modal fade show" style={styles.overlay}>
      <div className="modal-dialog" style={styles.dialog}>
        <div className="modal-content" style={styles.content}>
          <div style={styles.header}>
            <div>
              <h5 style={styles.title}>Criar Reserva (Admin)</h5>
              {quadraNome && <div style={styles.subtitle}>{quadraNome}</div>}
            </div>
            <button
              type="button"
              onClick={onFechar}
              style={styles.btnX}
              aria-label="Fechar"
              title="Fechar"
            >
              &times;
            </button>
          </div>

          <div style={styles.body}>
            {erro && <div className="alert alert-danger">{erro}</div>}

            <div className="row g-3">
              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Data e Horário
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Data</label>
                <input
                  type="date"
                  style={styles.input}
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Hora</label>
                <input
                  type="time"
                  style={styles.input}
                  value={hora}
                  onChange={(e) => setHora(e.target.value)}
                />
              </div>

              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Cliente (opcional)
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>CPF</label>
                <input
                  type="text"
                  style={styles.input}
                  value={cpf}
                  onChange={(e) => setCpf(e.target.value)}
                  placeholder="Somente números ou texto"
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Telefone/WhatsApp</label>
                <input
                  type="text"
                  style={styles.input}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Ex: 21999999999"
                />
              </div>

              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Valor (estatística)
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Preço total</label>
                <input
                  type="number"
                  style={styles.input}
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  placeholder="0"
                />
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                  Reserva do painel **não gera financeiro/repasses** (é só estatística).
                </div>
              </div>
            </div>
          </div>

          <div style={styles.footer}>
            <button className="btn btn-outline-secondary" onClick={onFechar} disabled={salvando}>
              Cancelar
            </button>
            <button className="btn btn-success" onClick={salvar} disabled={salvando}>
              {salvando ? "Salvando..." : "Confirmar reserva"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================
// MODAL: EDITAR / CANCELAR (ADMIN)
// =====================================================
function EditarReservaModal({ aberto, onFechar, reserva, onAtualizado, onCancelado }) {
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (!aberto || !reserva) return;
    setErro("");
    setData(String(reserva.data || "").slice(0, 10));
    setHora(String(reserva.hora || "").slice(0, 5));
    setCpf(reserva.user_cpf || "");
    setPhone(reserva.phone || "");
    setValor(reserva.preco_total != null ? String(reserva.preco_total) : "");
  }, [aberto, reserva]);

  if (!aberto || !reserva) return null;

  const salvar = async () => {
    try {
      setSalvando(true);
      setErro("");
      const body = {
        quadraId: reserva.quadra_id,
        data,
        hora,
        cpf,
        phone,
        preco_total: valor !== "" ? Number(valor) : 0,
      };
      await api.put(`/admin/reservas/${reserva.id}`, body);
      if (onAtualizado) onAtualizado();
      onFechar();
    } catch (e) {
      const msg = e?.response?.data?.error || "Erro ao salvar edição.";
      setErro(msg);
    } finally {
      setSalvando(false);
    }
  };

  const cancelar = async () => {
    if (!window.confirm("ATENÇÃO: Deseja realmente CANCELAR esta reserva?")) return;
    try {
      setCancelando(true);
      setErro("");
      await api.delete(`/admin/reservas/${reserva.id}`);
      if (onCancelado) onCancelado();
      onFechar();
    } catch (e) {
      const msg = e?.response?.data?.error || "Erro ao cancelar reserva.";
      setErro(msg);
    } finally {
      setCancelando(false);
    }
  };

  const qNome = formatNomeQuadra(reserva?.quadras);

  return (
    <div className="modal fade show" style={styles.overlay}>
      <div className="modal-dialog" style={styles.dialog}>
        <div className="modal-content" style={styles.content}>
          <div style={styles.header}>
            <div>
              <h5 style={styles.title}>Gerenciar Reserva (Admin)</h5>
              <div style={styles.subtitle}>{qNome}</div>
              <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className={origemLabel(reserva.origem).cls}>{origemLabel(reserva.origem).t}</span>
                <span className={statusLabel(reserva.status).cls}>{statusLabel(reserva.status).t}</span>
                <span className="badge bg-light text-dark">ID: {reserva.id}</span>
              </div>
            </div>
            <button type="button" onClick={onFechar} style={styles.btnX} aria-label="Fechar">
              &times;
            </button>
          </div>

          <div style={styles.body}>
            {erro && <div className="alert alert-danger">{erro}</div>}

            <div className="row g-3">
              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Data e Horário
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Data</label>
                <input type="date" style={styles.input} value={data} onChange={(e) => setData(e.target.value)} />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Hora</label>
                <input type="time" style={styles.input} value={hora} onChange={(e) => setHora(e.target.value)} />
              </div>

              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Cliente
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>CPF</label>
                <input type="text" style={styles.input} value={cpf} onChange={(e) => setCpf(e.target.value)} />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Telefone</label>
                <input type="text" style={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>

              <div className="col-12">
                <div style={styles.sectionTitle}>
                  <span style={styles.sectionBar}></span>
                  Valor (estatística)
                </div>
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Preço total</label>
                <input type="number" style={styles.input} value={valor} onChange={(e) => setValor(e.target.value)} />
              </div>
            </div>
          </div>

          <div style={styles.footer}>
            <button className="btn btn-outline-danger" onClick={cancelar} disabled={cancelando || salvando}>
              {cancelando ? "Cancelando..." : "Cancelar reserva"}
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn btn-outline-secondary" onClick={onFechar} disabled={cancelando || salvando}>
              Fechar
            </button>
            <button className="btn btn-success" onClick={salvar} disabled={cancelando || salvando}>
              {salvando ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================
// PÁGINA: ADMIN RESERVAS
// =====================================================
export default function AdminReservasPage() {
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");

  // Base
  const [gestores, setGestores] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [quadras, setQuadras] = useState([]);

  // Filtros globais
  const [gestorId, setGestorId] = useState("");
  const [empresaId, setEmpresaId] = useState("");
  const [quadraId, setQuadraId] = useState("");

  const [status, setStatus] = useState("todas");
  const [origem, setOrigem] = useState("todas");
  const [inicio, setInicio] = useState("");
  const [fim, setFim] = useState("");
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");

  // Dados listagem
  const [itens, setItens] = useState([]);

  // Modais
  const [modalCriar, setModalCriar] = useState(false);
  const [modalEditar, setModalEditar] = useState(false);
  const [reservaSel, setReservaSel] = useState(null);
    // ==========================
  // CINEMA (grade)
  // ==========================
  const [modo, setModo] = useState("cinema"); // "cinema" | "global"

  const [cinemaInicio, setCinemaInicio] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });

  const [cinemaFim, setCinemaFim] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  });

  const [cinemaFiltro, setCinemaFiltro] = useState("todas"); // todas|disponivel|reservada|bloqueado
  const [cinemaGrade, setCinemaGrade] = useState([]); // [{data, slots:[]}]
  const [slotSelecionado, setSlotSelecionado] = useState(null); // slot clicado

  
  const empresasCinema = useMemo(() => empresas || [], [empresas]);

const empresasGlobal = useMemo(() => {
  if (!gestorId) return empresas || [];
  return (empresas || []).filter((e) => String(e.gestor_id) === String(gestorId));
}, [empresas, gestorId]);

  const quadrasFiltradas = useMemo(() => {
    let q = quadras || [];
    if (gestorId) q = q.filter((x) => String(x.gestor_id) === String(gestorId));
    if (empresaId) q = q.filter((x) => String(x.empresa_id) === String(empresaId));
    return q;
  }, [quadras, gestorId, empresaId]);

  const quadraSelecionada = useMemo(() => {
    return (quadras || []).find((q) => String(q.id) === String(quadraId)) || null;
  }, [quadras, quadraId]);

  const quadraNome = useMemo(() => formatNomeQuadra(quadraSelecionada), [quadraSelecionada]);

  async function carregarBases() {
    try {
      setCarregando(true);
      setErro("");
      setMsg("");

      const [rGest, rEmp, rQua] = await Promise.all([
        api.get("/admin/gestores-resumo"),
        api.get("/admin/empresas"),
        api.get("/admin/quadras"),
      ]);

      setGestores(rGest.data || []);
      setEmpresas(rEmp.data || []);

      // /admin/quadras retorna { quadras: [...] }
      const qPayload = rQua.data?.quadras || rQua.data || [];
      setQuadras(qPayload);

    } catch (e) {
      console.error("[ADMIN/RESERVAS] Erro ao carregar bases:", e);
      setErro(e?.response?.data?.error || "Erro ao carregar bases (gestores/empresas/quadras).");
    } finally {
      setCarregando(false);
    }
  }
  async function buscarGradeCinema() {
    try {
      setCarregando(true);
      setErro("");
      setMsg("");

      if (!quadraId) {
        setErro("Selecione uma quadra para visualizar a grade (cinema).");
        return;
      }

      const r = await api.get("/admin/reservas/grade", {
        params: {
          quadraId,
          dataInicio: cinemaInicio,
          dataFim: cinemaFim,
          filtro: cinemaFiltro,
        },
      });

      setCinemaGrade(r.data?.grade || []);
      setModo("cinema");
    } catch (e) {
      console.error("[ADMIN/RESERVAS][CINEMA] Erro ao buscar grade:", e);
      setErro(e?.response?.data?.error || "Erro ao buscar grade (cinema).");
    } finally {
      setCarregando(false);
    }
  }

  async function buscarReservas() {
    try {
      setCarregando(true);
      setErro("");
      setMsg("");

      const params = {};
      if (inicio) params.inicio = inicio;
      if (fim) params.fim = fim;
      if (status && status !== "todas") params.status = status;
      if (origem && origem !== "todas") params.origem = origem;
      if (gestorId) params.gestorId = gestorId;
      if (empresaId) params.empresaId = empresaId;
      if (quadraId) params.quadraId = quadraId;
      if (cpf) params.cpf = cpf;
      if (phone) params.phone = phone;

      const r = await api.get("/admin/reservas", { params });
      setItens(r.data?.itens || []);
    } catch (e) {
      console.error("[ADMIN/RESERVAS] Erro ao buscar reservas:", e);
      setErro(e?.response?.data?.error || "Erro ao listar reservas.");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregarBases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quando muda gestor/empresa, limpa quadra automaticamente (evita inconsistência)
 useEffect(() => {
  // Cinema: ao trocar empresa, limpa quadra (pra não ficar inconsistente)
  if (modo === "cinema") {
    setQuadraId("");
    setCinemaGrade([]);
    setSlotSelecionado(null); // opcional: limpa a grade na troca
  }

  // Global: se trocar gestor/empresa, limpa quadra também
  if (modo === "global") {
    setQuadraId("");
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [empresaId, gestorId, modo]);



  const abrirEditar = (r) => {
    setReservaSel(r);
    setModalEditar(true);
  };

  const limparFiltros = () => {
    setStatus("todas");
    setOrigem("todas");
    setInicio("");
    setFim("");
    setCpf("");
    setPhone("");
    setGestorId("");
    setEmpresaId("");
    setQuadraId("");
    setItens([]);
  };

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 className="page-title">Reservas (Admin)</h1>
          <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
            Visão global (filtros) + ações administrativas (criar/editar/cancelar).
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-outline-secondary" onClick={carregarBases} disabled={carregando}>
            Recarregar bases
          </button>
          <button
            className="btn btn-success"
            onClick={() => {
  setSlotSelecionado(null);
  setModalCriar(true);
}}

            disabled={!quadraId}
            title={!quadraId ? "Selecione uma quadra para criar reserva" : "Criar reserva"}
          >
            + Criar reserva (painel)
          </button>
        </div>
      </div>

      {erro && <div className="alert alert-danger">{erro}</div>}
      {msg && <div className="alert alert-success">{msg}</div>}

            {/* ==========================
          MODO (Cinema x Global)
         ========================== */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            className={`btn ${modo === "cinema" ? "btn-dark" : "btn-outline-dark"}`}
            onClick={() => setModo("cinema")}
            type="button"
          >
            Cinema (empresa → quadra → grade)
          </button>

          <button
            className={`btn ${modo === "global" ? "btn-dark" : "btn-outline-dark"}`}
            onClick={() => setModo("global")}
            type="button"
          >
            Visão global (filtros + listagem)
          </button>
        </div>
      </div>

      {/* ==========================
          CINEMA
         ========================== */}
      {modo === "cinema" && (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 14 }}>
            <div className="row g-3">
              <div className="col-lg-4">
                <label style={styles.fLabel}>Empresa/Complexo</label>
                <select className="form-select" value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
                  <option value="">Selecione...</option>
                  {(empresasCinema || []).map((e) => (

                    <option key={e.id} value={e.id}>{e.nome}</option>
                  ))}
                </select>
              </div>

              <div className="col-lg-4">
                <label style={styles.fLabel}>Quadra</label>
                <select className="form-select" value={quadraId} onChange={(e) => setQuadraId(e.target.value)}>
                  <option value="">Selecione...</option>
                  {(quadrasFiltradas || []).map((q) => (
                    <option key={q.id} value={q.id}>{formatNomeQuadra(q)}</option>
                  ))}
                </select>
              </div>

              <div className="col-lg-2">
                <label style={styles.fLabel}>Início</label>
                <input className="form-control" type="date" value={cinemaInicio} onChange={(e) => setCinemaInicio(e.target.value)} />
              </div>

              <div className="col-lg-2">
                <label style={styles.fLabel}>Fim</label>
                <input className="form-control" type="date" value={cinemaFim} onChange={(e) => setCinemaFim(e.target.value)} />
              </div>

              <div className="col-lg-3">
                <label style={styles.fLabel}>Filtro</label>
                <select className="form-select" value={cinemaFiltro} onChange={(e) => setCinemaFiltro(e.target.value)}>
                  <option value="todas">Todas</option>
                  <option value="disponivel">Disponível</option>
                  <option value="reservada">Reservada</option>
                  <option value="bloqueado">Bloqueado</option>
                </select>
              </div>

              <div className="col-12" style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button className="btn btn-primary" type="button" onClick={buscarGradeCinema} disabled={carregando || !quadraId}>
                  {carregando ? "Carregando..." : "Aplicar (Cinema)"}
                </button>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            {!quadraId ? (
              <div style={{ padding: 14, color: "#666" }}>Selecione uma quadra para ver a grade.</div>
            ) : (
              (cinemaGrade || []).map((dia) => (
                <div key={dia.data} style={{ padding: "12px 0", borderBottom: "1px solid rgba(0,0,0,.06)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>
                    {String(dia.data || "").slice(0, 10)}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
                    {(dia.slots || []).map((s) => {
                      const st = String(s.status || "").toUpperCase();
                      const isLivre = st === "DISPONIVEL";
                      const isRes = st === "RESERVADO";

                      const bg =
                        isLivre ? "#eafff2" : isRes ? "#fff7e6" : "#ffecec";
                      const bd =
                        isLivre ? "1px solid #b7f0cf" : isRes ? "1px solid #ffd9a8" : "1px solid #ffc1c1";

                      return (
                        <button
                          key={`${s.data}-${s.hora}`}
                          type="button"
                          onClick={() => {
                            if (isLivre) {
                              setSlotSelecionado(s);
                              setModalCriar(true);
                            } else if (isRes && s.reserva?.id) {
                              // abre seu modal editar usando um “reservaSel” compatível
                              setReservaSel({
                                ...s.reserva,
                                quadra_id: quadraId,
                                data: s.data,
                                hora: s.hora,
                                // tenta manter compatibilidade com seu modal que usa quadras/empresas:
                                quadras: quadraSelecionada ? { ...quadraSelecionada, empresas: (empresas || []).find(e => String(e.id) === String(quadraSelecionada.empresa_id)) } : null,
                              });
                              setModalEditar(true);
                            } else {
                              setMsg("Horário BLOQUEADO.");
                              setTimeout(() => setMsg(""), 2000);
                            }
                          }}
                          style={{
                            textAlign: "left",
                            borderRadius: 12,
                            padding: 10,
                            background: bg,
                            border: bd,
                            cursor: "pointer",
                          }}
                          title={st}
                        >
                          <div style={{ fontWeight: 900 }}>{String(s.hora || "").slice(0, 5)}</div>
                          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{st}</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
                            {isLivre ? `Preço: R$ ${round2(s.preco_hora).toFixed(2)}` : ""}
                            {isRes && s.reserva ? `Valor: R$ ${round2(s.reserva.preco_total).toFixed(2)}` : ""}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
      {modo === "global" && (
      <>
      {/* FILTROS */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="row g-3">
          <div className="col-lg-3">
            <label style={styles.fLabel}>Gestor</label>
            <select className="form-select" value={gestorId} onChange={(e) => setGestorId(e.target.value)}>
              <option value="">Todos</option>
              {(gestores || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome} ({g.email})
                </option>
              ))}
            </select>
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Empresa/Complexo</label>
            <select className="form-select" value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
              <option value="">Todas</option>
              {(empresasGlobal || []).map((e) => (

                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Quadra</label>
            <select className="form-select" value={quadraId} onChange={(e) => setQuadraId(e.target.value)}>
              <option value="">Todas</option>
              {(quadrasFiltradas || []).map((q) => (
                <option key={q.id} value={q.id}>
                  {formatNomeQuadra(q)}
                </option>
              ))}
            </select>
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Status</label>
            <select className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="todas">Todos</option>
              <option value="pending">Pendente</option>
              <option value="paid">Pago</option>
              <option value="canceled">Cancelado</option>
            </select>
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Origem</label>
            <select className="form-select" value={origem} onChange={(e) => setOrigem(e.target.value)}>
              <option value="todas">Todas</option>
              <option value="painel">Painel</option>
              <option value="whatsapp">WhatsApp/PIX</option>
            </select>
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Início</label>
            <input className="form-control" type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} />
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Fim</label>
            <input className="form-control" type="date" value={fim} onChange={(e) => setFim(e.target.value)} />
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>CPF</label>
            <input className="form-control" value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="Filtrar CPF" />
          </div>

          <div className="col-lg-3">
            <label style={styles.fLabel}>Telefone</label>
            <input
              className="form-control"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Filtrar telefone"
            />
          </div>

          <div className="col-12" style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button className="btn btn-outline-secondary" type="button" onClick={limparFiltros} disabled={carregando}>
              Limpar
            </button>
            <button className="btn btn-primary" type="button" onClick={buscarReservas} disabled={carregando}>
              {carregando ? "Buscando..." : "Aplicar filtros"}
            </button>
          </div>
        </div>
      </div>

      {/* LISTAGEM */}
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800 }}>Listagem (visão global)</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {itens.length} item(ns) • reservas do painel entram como <b>paid</b> e não geram repasse/financeiro.
          </div>
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Data</th>
                <th>Hora</th>
                <th>Quadra</th>
                <th>Empresa</th>
                <th>Gestor</th>
                <th>Origem</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Valor</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {itens.map((r) => {
                const emp = r?.quadras?.empresas;
                const gId = r?.quadras?.gestor_id;
                const g = (gestores || []).find((x) => String(x.id) === String(gId));
                return (
                  <tr key={r.id}>
                    <td>{String(r.data || "").slice(0, 10)}</td>
                    <td>{String(r.hora || "").slice(0, 5)}</td>
                    <td>{formatNomeQuadra(r.quadras)}</td>
                    <td>{emp?.nome || "—"}</td>
                    <td>{g?.nome || gId || "—"}</td>
                    <td>
                      <span className={origemLabel(r.origem).cls}>{origemLabel(r.origem).t}</span>
                    </td>
                    <td>
                      <span className={statusLabel(r.status).cls}>{statusLabel(r.status).t}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>R$ {round2(r.preco_total).toFixed(2)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-outline-primary" onClick={() => abrirEditar(r)}>
                        Gerenciar
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!itens.length && (
                <tr>
                  <td colSpan={9} style={{ padding: 14, color: "#666" }}>
                    Nenhuma reserva encontrada. Use os filtros e clique em <b>Aplicar filtros</b>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
       </>
)}
      {/* MODAIS */}
            <CriarReservaModal
        aberto={modalCriar}
        onFechar={() => setModalCriar(false)}
        quadraId={quadraId}
        quadraNome={quadraNome}
        onCriada={() => {
          // atualiza o que estiver aberto
          if (modo === "cinema") buscarGradeCinema();
          else buscarReservas();
        }}
        dataSug={slotSelecionado?.data || ""}
        horaSug={slotSelecionado?.hora || ""}
      />


            <EditarReservaModal
        aberto={modalEditar}
        onFechar={() => setModalEditar(false)}
        reserva={reservaSel}
        onAtualizado={() => (modo === "cinema" ? buscarGradeCinema() : buscarReservas())}
        onCancelado={() => (modo === "cinema" ? buscarGradeCinema() : buscarReservas())}
      />

    </div>
  );
}

// =====================================================
// Estilos (mantém “cara” próxima do Gestor)
// =====================================================
const styles = {
  fLabel: { fontSize: 12, fontWeight: 800, marginBottom: 6, color: "#374151" },

  overlay: {
    display: "block",
    background: "rgba(0,0,0,.55)",
  },
  dialog: {
    maxWidth: 720,
    margin: "8vh auto",
  },
  content: {
    borderRadius: 14,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,.08)",
  },
  header: {
    padding: "14px 16px",
    borderBottom: "1px solid rgba(0,0,0,.08)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  title: { margin: 0, fontWeight: 900 },
  subtitle: { fontSize: 13, opacity: 0.8, marginTop: 4 },
  btnX: {
    background: "transparent",
    border: "none",
    fontSize: "1.7rem",
    color: "#9ca3af",
    cursor: "pointer",
    lineHeight: 1,
  },
  body: { padding: 16 },
  footer: {
    padding: 16,
    borderTop: "1px solid rgba(0,0,0,.08)",
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontWeight: 900,
    color: "#111827",
  },
  sectionBar: {
    width: 10,
    height: 10,
    borderRadius: 99,
    background: "#16a34a",
    display: "inline-block",
  },
  label: { fontSize: 12, fontWeight: 800, marginBottom: 6, color: "#374151" },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,.15)",
    outline: "none",
  },
};
