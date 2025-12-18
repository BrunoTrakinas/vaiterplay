// ✅ SUBSTITUA O ARQUIVO INTEIRO
// Arquivo: src/pages/admin/AdminReservasPage.jsx
//
// O que este arquivo faz:
// - Mantém a tela principal 100% CLONE do Gestor (Cinema)
// - Adiciona um botão discreto "Avançado" abaixo do botão Aplicar
// - "Avançado" abre um MODAL (fecha clicando fora) com a TABELA GLOBAL
// - Tabela global usa GET /admin/reservas (filtros avançados)
// - Ações por linha: Editar / Cancelar (reaproveitando o modal existente)
//
// Endpoints usados:
//   - GET  /admin/gestores-resumo
//   - GET  /admin/empresas
//   - GET  /admin/quadras
//   - GET  /admin/reservas/grade
//   - GET  /admin/reservas
//   - POST /admin/reservas
//   - PUT  /admin/reservas/:id
//   - DELETE /admin/reservas/:id

import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

// -------------------- utils --------------------
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function formatarDataBR(iso) {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10); // YYYY-MM-DD
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

function formatNomeQuadra(q) {
  if (!q) return "—";
  return (
    q.nome_dinamico ||
    q.nome ||
    `${q.tipo || "Quadra"}${q.material ? ` • ${q.material}` : ""}${
      q.modalidade ? ` • ${q.modalidade}` : ""
    }`
  );
}

function normalizarStatusSlot(slot) {
  const raw = String(slot?.status || "").toLowerCase().trim();
  if (raw === "reservado" || raw === "reservada") return "reservado";
  if (raw === "bloqueado" || raw === "bloqueada") return "bloqueado";
  if (raw === "disponivel" || raw === "disponível") return "disponivel";

  // backend admin/grade tende a mandar "DISPONIVEL/RESERVADO/BLOQUEADO"
  if (raw.includes("reserv")) return "reservado";
  if (raw.includes("bloq")) return "bloqueado";
  return "disponivel";
}

function corSlot(slot) {
  const st = normalizarStatusSlot(slot);
  if (st === "disponivel") return "#198754"; // verde
  if (st === "reservado") return "#dc3545"; // vermelho
  return "#6c757d"; // cinza
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function plusDiasISO(baseISO, dias) {
  const d = new Date(baseISO ? `${String(baseISO).slice(0, 10)}T00:00:00` : Date.now());
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

// -------------------- MODAL: Criar Reserva --------------------
function CriarReservaModal({
  aberto,
  onFechar,
  quadraId,
  quadraNome,
  onCriada,
  dataSug,
  horaSug,
  precoSug,
}) {
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
    if (dataSug) setData(String(dataSug).slice(0, 10));
    if (horaSug) setHora(String(horaSug).slice(0, 5));
    if (precoSug != null) setValor(String(precoSug));
  }, [aberto, dataSug, horaSug, precoSug]);

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
      setErro(e?.response?.data?.error || "Erro ao criar reserva.");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.content}>
          <div style={styles.header}>
            <div>
              <h5 style={styles.title}>Criar reserva (Admin)</h5>
              {quadraNome && <div style={styles.subtitle}>{quadraNome}</div>}
            </div>
            <button type="button" onClick={onFechar} style={styles.btnX} aria-label="Fechar">
              &times;
            </button>
          </div>

          <div style={styles.body}>
            {erro && <div className="alert alert-danger">{erro}</div>}

            <div className="row g-3">
              <div className="col-md-6">
                <label style={styles.label}>Data</label>
                <input
                  type="date"
                  className="form-control"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Hora</label>
                <input
                  type="time"
                  className="form-control"
                  value={hora}
                  onChange={(e) => setHora(e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>CPF (opcional)</label>
                <input
                  className="form-control"
                  value={cpf}
                  onChange={(e) => setCpf(e.target.value)}
                  placeholder="CPF"
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Telefone (opcional)</label>
                <input
                  className="form-control"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Ex: 21999999999"
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Valor (estatística)</label>
                <input
                  type="number"
                  className="form-control"
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  placeholder="0"
                />
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                  Reserva do painel entra como <b>paid</b> e é só estatística.
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

// -------------------- MODAL: Editar/Cancelar --------------------
function EditarReservaModal({ aberto, onFechar, reserva, onAtualizado }) {
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

    // aceita ambos (grade pode vir cpf OU user_cpf dependendo do backend)
    setCpf(reserva.cpf || reserva.user_cpf || reserva.user_cpf_top || reserva.user_cpf_list || "");
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
      setErro(e?.response?.data?.error || "Erro ao salvar edição.");
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
      if (onAtualizado) onAtualizado();
      onFechar();
    } catch (e) {
      setErro(e?.response?.data?.error || "Erro ao cancelar reserva.");
    } finally {
      setCancelando(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.content}>
          <div style={styles.header}>
            <div>
              <h5 style={styles.title}>Gerenciar reserva (Admin)</h5>
              <div style={styles.subtitle}>ID: {reserva.id}</div>
            </div>
            <button type="button" onClick={onFechar} style={styles.btnX} aria-label="Fechar">
              &times;
            </button>
          </div>

          <div style={styles.body}>
            {erro && <div className="alert alert-danger">{erro}</div>}

            <div className="row g-3">
              <div className="col-md-6">
                <label style={styles.label}>Data</label>
                <input
                  type="date"
                  className="form-control"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Hora</label>
                <input
                  type="time"
                  className="form-control"
                  value={hora}
                  onChange={(e) => setHora(e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>CPF</label>
                <input className="form-control" value={cpf} onChange={(e) => setCpf(e.target.value)} />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Telefone</label>
                <input className="form-control" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>

              <div className="col-md-6">
                <label style={styles.label}>Valor (estatística)</label>
                <input
                  type="number"
                  className="form-control"
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                />
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

// -------------------- MODAL: Avançado (Tabela Global) --------------------
function AvancadoModal({
  aberto,
  onFechar,
  gestores,
  empresas,
  quadras,
  onEditarReserva, // callback(reservaPadronizada)
}) {
  const [inicio, setInicio] = useState(hojeISO());
  const [fim, setFim] = useState(plusDiasISO(hojeISO(), 7));
  const [status, setStatus] = useState("");
  const [origem, setOrigem] = useState("");
  const [gestorId, setGestorId] = useState("");
  const [empresaId, setEmpresaId] = useState("");
  const [quadraId, setQuadraId] = useState("");
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");

  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [itens, setItens] = useState([]);

  // quando abre, não deixa lixo de erro antigo
  useEffect(() => {
    if (!aberto) return;
    setErro("");
  }, [aberto]);

  const empresasFiltradas = useMemo(() => {
    let list = empresas || [];
    if (gestorId) list = list.filter((e) => String(e.gestor_id) === String(gestorId));
    return list;
  }, [empresas, gestorId]);

  const quadrasFiltradas = useMemo(() => {
    let list = quadras || [];
    if (gestorId) list = list.filter((q) => String(q.gestor_id) === String(gestorId));
    if (empresaId) list = list.filter((q) => String(q.empresa_id) === String(empresaId));
    return list;
  }, [quadras, gestorId, empresaId]);

  useEffect(() => {
    // ao trocar gestor/empresa, mantém coerência
    setEmpresaId("");
    setQuadraId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gestorId]);

  useEffect(() => {
    setQuadraId("");
  }, [empresaId]);

  if (!aberto) return null;

  const buscar = async () => {
    try {
      setCarregando(true);
      setErro("");

      // regra de UX: evitar busca “sem filtro nenhum”
      // (se você quiser remover isso, é só apagar o IF)
      if (!inicio && !fim && !cpf && !phone && !quadraId && !empresaId && !gestorId) {
        setErro("Use ao menos um filtro (ex.: período, CPF, telefone, empresa ou quadra).");
        setItens([]);
        return;
      }

      const r = await api.get("/admin/reservas", {
        params: {
          inicio: inicio || undefined,
          fim: fim || undefined,
          status: status || undefined,
          origem: origem || undefined,
          gestorId: gestorId || undefined,
          empresaId: empresaId || undefined,
          quadraId: quadraId || undefined,
          cpf: cpf || undefined,
          phone: phone || undefined,
        },
      });

      const list = r.data?.itens || [];
      setItens(list);
      if (!list.length) setErro("Nenhuma reserva encontrada para os filtros selecionados.");
    } catch (e) {
      setErro(e?.response?.data?.error || "Erro ao buscar reservas (avançado).");
      setItens([]);
    } finally {
      setCarregando(false);
    }
  };

  const limpar = () => {
    setInicio(hojeISO());
    setFim(plusDiasISO(hojeISO(), 7));
    setStatus("");
    setOrigem("");
    setGestorId("");
    setEmpresaId("");
    setQuadraId("");
    setCpf("");
    setPhone("");
    setErro("");
    setItens([]);
  };

  const mapLinhaParaReservaModal = (it) => {
    // padroniza para o EditarReservaModal (admin)
    return {
      id: it.id,
      quadra_id: it.quadra_id,
      data: it.data,
      hora: String(it.hora || "").slice(0, 5),
      preco_total: it.preco_total,
      phone: it.phone || "",
      cpf: it.user_cpf || it.cpf || "",
      user_cpf: it.user_cpf || "",
      // extras (não atrapalham)
      status: it.status,
      origem: it.origem,
    };
  };

  const nomeGestor = (id) => {
    const g = (gestores || []).find((x) => String(x.id) === String(id));
    return g ? g.nome : "—";
  };

  const nomeEmpresa = (it) => {
    return it?.quadras?.empresas?.nome || "—";
  };

  const nomeQuadra = (it) => {
    const q = it?.quadras;
    if (!q) return "—";
    return formatNomeQuadra(q);
  };

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.dialogWide} onClick={(e) => e.stopPropagation()}>
        <div style={styles.content}>
          <div style={styles.header}>
            <div>
              <h5 style={styles.title}>Pesquisa avançada (Admin)</h5>
              <div style={styles.subtitle}>
                Tabela global de reservas (filtros + edição/cancelamento).
              </div>
            </div>
            <button type="button" onClick={onFechar} style={styles.btnX} aria-label="Fechar">
              &times;
            </button>
          </div>

          <div style={styles.body}>
            {/* FILTROS (Avançado) — dropdowns “bonitos” */}
<div className="card" style={{ padding: 16, borderRadius: 12 }}>
  <div className="row g-4">
    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Início</label>
        <input
          className="form-control"
          style={styles.control}
          type="date"
          value={inicio}
          onChange={(e) => setInicio(e.target.value)}
        />
      </div>
    </div>

    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Fim</label>
        <input
          className="form-control"
          style={styles.control}
          type="date"
          value={fim}
          onChange={(e) => setFim(e.target.value)}
        />
      </div>
    </div>

    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Status</label>
        <select
          className="form-select"
          style={styles.control}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Todos</option>
          <option value="pending">pending</option>
          <option value="paid">paid</option>
          <option value="canceled">canceled</option>
        </select>
      </div>
    </div>

    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Origem</label>
        <select
          className="form-select"
          style={styles.control}
          value={origem}
          onChange={(e) => setOrigem(e.target.value)}
        >
          <option value="">Todas</option>
          <option value="painel">painel</option>
          <option value="whatsapp">whatsapp</option>
        </select>
      </div>
    </div>

    <div className="col-lg-4 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Gestor</label>
        <select
          className="form-select"
          style={styles.control}
          value={gestorId}
          onChange={(e) => setGestorId(e.target.value)}
        >
          <option value="">Todos</option>
          {(gestores || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome} ({g.email})
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-4 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Empresa</label>
        <select
          className="form-select"
          style={styles.control}
          value={empresaId}
          onChange={(e) => setEmpresaId(e.target.value)}
        >
          <option value="">Todas</option>
          {(empresasFiltradas || []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-4 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Quadra</label>
        <select
          className="form-select"
          style={styles.control}
          value={quadraId}
          onChange={(e) => setQuadraId(e.target.value)}
        >
          <option value="">Todas</option>
          {(quadrasFiltradas || []).map((q) => (
            <option key={q.id} value={q.id}>
              {formatNomeQuadra(q)}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>CPF</label>
        <input
          className="form-control"
          style={styles.control}
          value={cpf}
          onChange={(e) => setCpf(e.target.value)}
          placeholder="Buscar por CPF"
        />
      </div>
    </div>

    <div className="col-lg-3 col-md-6">
      <div style={styles.field}>
        <label style={styles.fLabel}>Telefone</label>
        <input
          className="form-control"
          style={styles.control}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Buscar por telefone"
        />
      </div>
    </div>

    <div
      className="col-lg-6 col-md-12"
      style={{
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "flex-end",
        gap: 10,
      }}
    >
      <button
        className="btn btn-outline-secondary"
        type="button"
        onClick={limpar}
        disabled={carregando}
        style={{ height: 42, padding: "10px 16px", borderRadius: 10, fontWeight: 800 }}
      >
        Limpar
      </button>

      <button
        className="btn btn-primary"
        type="button"
        onClick={buscar}
        disabled={carregando}
        style={{ height: 42, padding: "10px 18px", borderRadius: 10, fontWeight: 900 }}
      >
        {carregando ? "Buscando..." : "Buscar"}
      </button>
    </div>
  </div>
</div>



            {erro && (
              <div className="alert alert-warning mt-3" style={{ marginBottom: 0 }}>
                {erro}
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ fontWeight: 800 }}>Resultados</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {itens.length ? `${itens.length} item(ns)` : "—"}
                </div>
              </div>

              <div
                style={{
                  marginTop: 10,
                  border: "1px solid rgba(0,0,0,.08)",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <div style={{ overflowX: "auto", maxHeight: "55vh" }}>
                  <table className="table table-sm" style={{ margin: 0, minWidth: 1100 }}>
                    <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
                      <tr>
                        <th>Data</th>
                        <th>Hora</th>
                        <th>Status</th>
                        <th>Origem</th>
                        <th>Quadra</th>
                        <th>Empresa</th>
                        <th>Gestor</th>
                        <th>CPF</th>
                        <th>Telefone</th>
                        <th>Valor</th>
                        <th style={{ width: 180 }}>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(itens || []).map((it) => {
                        const gestorIdLinha = it?.quadras?.gestor_id || it?.quadras?.empresas?.gestor_id || "";
                        return (
                          <tr key={it.id}>
                            <td>{formatarDataBR(it.data)}</td>
                            <td>{safeStr(it.hora).slice(0, 5)}</td>
                            <td>{safeStr(it.status)}</td>
                            <td>{safeStr(it.origem)}</td>
                            <td>{nomeQuadra(it)}</td>
                            <td>{nomeEmpresa(it)}</td>
                            <td>{nomeGestor(gestorIdLinha)}</td>
                            <td>{safeStr(it.user_cpf || it.cpf || "")}</td>
                            <td>{safeStr(it.phone || "")}</td>
                            <td>R$ {round2(it.preco_total).toFixed(2)}</td>
                            <td>
                              <div style={{ display: "flex", gap: 8 }}>
                                <button
                                  className="btn btn-outline-primary btn-sm"
                                  type="button"
                                  onClick={() => onEditarReserva(mapLinhaParaReservaModal(it))}
                                >
                                  Editar
                                </button>
                                <button
                                  className="btn btn-outline-danger btn-sm"
                                  type="button"
                                  onClick={() => onEditarReserva(mapLinhaParaReservaModal(it)) /* modal tem botão cancelar */}
                                >
                                  Cancelar
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}

                      {!itens.length && (
                        <tr>
                          <td colSpan={11} style={{ textAlign: "center", padding: 18, opacity: 0.7 }}>
                            Nenhum resultado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
                Dica: use período + CPF/telefone para achar rápido. Ações por linha abrem o modal de edição/cancelamento.
              </div>
            </div>
          </div>

          <div style={styles.footer}>
            <button className="btn btn-outline-secondary" onClick={onFechar}>
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------- PAGE: Admin Reservas (cinema clone + avançado) --------------------
export default function AdminReservasPage() {
  // bases
  const [carregandoBases, setCarregandoBases] = useState(false);
  const [erroBases, setErroBases] = useState("");

  const [gestores, setGestores] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [quadras, setQuadras] = useState([]);

  // filtros (cinema)
  const [gestorId, setGestorId] = useState("");
  const [empresaId, setEmpresaId] = useState("");
  const [quadraId, setQuadraId] = useState("");

  const [cinemaInicio, setCinemaInicio] = useState(() => hojeISO());
  const [cinemaFim, setCinemaFim] = useState(() => plusDiasISO(hojeISO(), 6));
  const [cinemaFiltro, setCinemaFiltro] = useState("todas");

  // grade
  const [carregandoGrade, setCarregandoGrade] = useState(false);
  const [erroGrade, setErroGrade] = useState("");
  const [mensagemInfo, setMensagemInfo] = useState("");
  const [grade, setGrade] = useState([]);

  // modais
  const [modalCriarAberto, setModalCriarAberto] = useState(false);
  const [modalEditarAberto, setModalEditarAberto] = useState(false);
  const [modalAvancadoAberto, setModalAvancadoAberto] = useState(false);

  const [slotSelecionado, setSlotSelecionado] = useState(null);
  const [reservaSelecionada, setReservaSelecionada] = useState(null);

  const empresasFiltradas = useMemo(() => {
    let list = empresas || [];
    if (gestorId) list = list.filter((e) => String(e.gestor_id) === String(gestorId));
    return list;
  }, [empresas, gestorId]);

  const quadrasFiltradas = useMemo(() => {
    let list = quadras || [];
    if (gestorId) list = list.filter((q) => String(q.gestor_id) === String(gestorId));
    if (empresaId) list = list.filter((q) => String(q.empresa_id) === String(empresaId));
    return list;
  }, [quadras, gestorId, empresaId]);

  const quadraSelecionada = useMemo(() => {
    return (quadras || []).find((q) => String(q.id) === String(quadraId)) || null;
  }, [quadras, quadraId]);

  const quadraNome = useMemo(() => formatNomeQuadra(quadraSelecionada), [quadraSelecionada]);

  async function carregarBases() {
    try {
      setCarregandoBases(true);
      setErroBases("");

      const [rGest, rEmp, rQua] = await Promise.all([
        api.get("/admin/gestores-resumo"),
        api.get("/admin/empresas"),
        api.get("/admin/quadras"),
      ]);

      setGestores(rGest.data || []);
      setEmpresas(rEmp.data || []);

      const qPayload = rQua.data?.quadras || rQua.data || [];
      setQuadras(qPayload);
    } catch (e) {
      console.error("[ADMIN/RESERVAS] Erro ao carregar bases:", e);
      setErroBases(e?.response?.data?.error || "Erro ao carregar bases (gestores/empresas/quadras).");
    } finally {
      setCarregandoBases(false);
    }
  }

  async function aplicarCinema() {
    try {
      setCarregandoGrade(true);
      setErroGrade("");
      setMensagemInfo("");

      if (!quadraId) {
        setErroGrade("Selecione uma quadra para visualizar a grade.");
        setGrade([]);
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

      const g = r.data?.grade || [];
      setGrade(g);

      if (!g.length) {
        setMensagemInfo("Nenhum horário encontrado para o período selecionado.");
      }
    } catch (e) {
      console.error("[ADMIN/RESERVAS][CINEMA] Erro ao buscar grade:", e);
      setErroGrade(e?.response?.data?.error || "Erro ao buscar grade (cinema).");
      setGrade([]);
    } finally {
      setCarregandoGrade(false);
    }
  }

  useEffect(() => {
    carregarBases();
  }, []);

  // ao trocar gestor/empresa, limpa quadra + grade
  useEffect(() => {
    setQuadraId("");
    setGrade([]);
    setMensagemInfo("");
    setErroGrade("");
    setSlotSelecionado(null);
    setReservaSelecionada(null);
  }, [gestorId, empresaId]);

  const abrirModalCriar = (dia, slot) => {
    setSlotSelecionado({
      data: dia.data,
      hora: slot.hora,
      preco_hora: slot.preco_hora,
    });
    setModalCriarAberto(true);
  };

  const abrirModalEditarFromSlot = (slot) => {
    if (!slot?.reserva?.id) return;
    setReservaSelecionada({
      id: slot.reserva.id,
      quadra_id: quadraId,
      data: slot.data,
      hora: slot.hora,
      preco_total: slot.reserva.preco_total,
      phone: slot.reserva.phone,
      // grade pode vir cpf ou user_cpf dependendo do backend
      cpf: slot.reserva.cpf || slot.reserva.user_cpf || "",
      user_cpf: slot.reserva.user_cpf || "",
      status: slot.reserva.status,
      origem: slot.reserva.origem,
    });
    setModalEditarAberto(true);
  };

  const abrirModalEditarFromTabela = (reservaPadronizada) => {
    setReservaSelecionada(reservaPadronizada);
    setModalEditarAberto(true);
  };

  const renderCinema = () => {
    if (!quadraId) {
      return (
        <p className="text-muted mt-3">
          Selecione um gestor (opcional), uma empresa e uma quadra para visualizar a agenda.
        </p>
      );
    }

    if (carregandoGrade) return <p className="mt-3">Carregando horários...</p>;

    if (erroGrade) {
      return (
        <p className="mt-3 text-danger" style={{ fontWeight: 600 }}>
          {erroGrade}
        </p>
      );
    }

    if (mensagemInfo) {
      return (
        <p className="mt-3 text-muted" style={{ fontStyle: "italic" }}>
          {mensagemInfo}
        </p>
      );
    }

    if (!grade || !grade.length) return null;

    return (
      <div className="mt-4">
        <h5 className="mb-3">Agenda estilo cinema</h5>

        <div
          style={{
            borderRadius: "8px",
            border: "1px solid #dee2e6",
            padding: "16px",
            backgroundColor: "#f8f9fa",
          }}
        >
          {grade.map((dia) => (
            <div key={dia.data} className="mb-4">
              <div style={{ fontWeight: 600, marginBottom: "8px", fontSize: "0.95rem" }}>
                {formatarDataBR(dia.data)}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {dia.slots && dia.slots.length ? (
                  dia.slots.map((slot) => {
                    const statusNorm = normalizarStatusSlot(slot);

                    return (
                      <div
                        key={`${dia.data}-${slot.hora}`}
                        style={{
                          minWidth: "92px",
                          textAlign: "center",
                          padding: "6px 8px",
                          borderRadius: "4px",
                          backgroundColor: corSlot(slot),
                          color: "#fff",
                          fontSize: "0.85rem",
                          cursor: statusNorm === "bloqueado" ? "not-allowed" : "pointer",
                          opacity: statusNorm === "bloqueado" ? 0.7 : 1,
                        }}
                        title={String(slot.status || "").toUpperCase()}
                        onClick={() => {
                          if (statusNorm === "bloqueado") return;
                          if (statusNorm === "disponivel") return abrirModalCriar(dia, slot);
                          return abrirModalEditarFromSlot({ ...slot, data: dia.data });
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{String(slot.hora || "").slice(0, 5)}</div>
                        <div style={{ fontSize: 11, opacity: 0.95, marginTop: 2 }}>
                          {statusNorm === "disponivel" && `R$ ${round2(slot.preco_hora).toFixed(2)}`}
                          {statusNorm === "reservado" && `R$ ${round2(slot?.reserva?.preco_total).toFixed(2)}`}
                          {statusNorm === "bloqueado" && "BLOQ"}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-muted">Nenhum horário disponível para este dia.</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
  <div>
    <h1 className="page-title">Reservas (Admin)</h1>
    <p style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
      Tela principal é o clone do Gestor (Cinema). Use “Avançado” para pesquisa global em tabela.
    </p>
  </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-outline-secondary" onClick={carregarBases} disabled={carregandoBases}>
            {carregandoBases ? "Recarregando..." : "Recarregar bases"}
          </button>
          <button
            className="btn btn-success"
            onClick={() => setModalCriarAberto(true)}
            disabled={!quadraId}
            title={!quadraId ? "Selecione uma quadra para criar reserva" : "Criar reserva"}
          >
            + Criar reserva (painel)
          </button>
        </div>
      </div>

      {erroBases && <div className="alert alert-danger">{erroBases}</div>}

     {/* FILTROS (Cinema) */}
<div className="card" style={{ padding: 14 }}>
  <div className="row g-3">
    <div className="col-lg-4">
      <div style={styles.field}>
        <label style={styles.fLabel}>Gestor (opcional)</label>
        <select
          className="form-select"
          style={styles.control}
          value={gestorId}
          onChange={(e) => setGestorId(e.target.value)}
        >
          <option value="">Todos</option>
          {(gestores || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome} ({g.email})
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-4">
      <div style={styles.field}>
        <label style={styles.fLabel}>Empresa/Complexo</label>
        <select
          className="form-select"
          style={styles.control}
          value={empresaId}
          onChange={(e) => setEmpresaId(e.target.value)}
        >
          <option value="">Selecione...</option>
          {(empresasFiltradas || []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-4">
      <div style={styles.field}>
        <label style={styles.fLabel}>Quadra</label>
        <select
          className="form-select"
          style={styles.control}
          value={quadraId}
          onChange={(e) => setQuadraId(e.target.value)}
        >
          <option value="">Selecione...</option>
          {(quadrasFiltradas || []).map((q) => (
            <option key={q.id} value={q.id}>
              {formatNomeQuadra(q)}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div className="col-lg-3">
      <div style={styles.field}>
        <label style={styles.fLabel}>Início</label>
        <input
          className="form-control"
          style={styles.control}
          type="date"
          value={cinemaInicio}
          onChange={(e) => setCinemaInicio(e.target.value)}
        />
      </div>
    </div>

    <div className="col-lg-3">
      <div style={styles.field}>
        <label style={styles.fLabel}>Fim</label>
        <input
          className="form-control"
          style={styles.control}
          type="date"
          value={cinemaFim}
          onChange={(e) => setCinemaFim(e.target.value)}
        />
      </div>
    </div>

    <div className="col-lg-3">
      <div style={styles.field}>
        <label style={styles.fLabel}>Filtro</label>
        <select
          className="form-select"
          style={styles.control}
          value={cinemaFiltro}
          onChange={(e) => setCinemaFiltro(e.target.value)}
        >
          <option value="todas">Todas</option>
          <option value="disponivel">Disponível</option>
          <option value="reservada">Reservada</option>
          <option value="bloqueado">Bloqueado</option>
        </select>
      </div>
    </div>

    <div
      className="col-lg-3"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        justifyContent: "end",
        gap: 8,
      }}
    >
      <button
        className="btn btn-primary"
        type="button"
        onClick={aplicarCinema}
        disabled={carregandoGrade}
        style={{ height: 42, padding: "10px 16px", borderRadius: 10, fontWeight: 800 }}
      >
        {carregandoGrade ? "Aplicando..." : "Aplicar"}
      </button>

      {/* ✅ botão discreto (não bagunça a UI) */}
      <button
        type="button"
        onClick={() => setModalAvancadoAberto(true)}
        style={styles.linkBtn}
        title="Abrir pesquisa avançada (tabela global)"
      >
        Avançado
      </button>
    </div>
  </div>
</div>


      {/* CINEMA */}
      {renderCinema()}

      {/* MODAIS */}
      <CriarReservaModal
        aberto={modalCriarAberto}
        onFechar={() => setModalCriarAberto(false)}
        quadraId={quadraId}
        quadraNome={quadraNome}
        dataSug={slotSelecionado?.data || ""}
        horaSug={slotSelecionado?.hora || ""}
        precoSug={slotSelecionado?.preco_hora ?? ""}
        onCriada={aplicarCinema}
      />

      <EditarReservaModal
        aberto={modalEditarAberto}
        onFechar={() => setModalEditarAberto(false)}
        reserva={reservaSelecionada}
        onAtualizado={() => {
          // atualiza grade (se estiver usando cinema)
          aplicarCinema();
        }}
      />

      <AvancadoModal
        aberto={modalAvancadoAberto}
        onFechar={() => setModalAvancadoAberto(false)}
        gestores={gestores}
        empresas={empresas}
        quadras={quadras}
        onEditarReserva={abrirModalEditarFromTabela}
      />
    </div>
  );
}

// -------------------- estilos --------------------
const styles = {
  fLabel: { fontSize: 12, fontWeight: 800, margin: 0, color: "#374151" },


  // ✅ NOVO: espaçamento e tamanho dos inputs/selects do filtro cinema
  control: {
    height: 42,
    padding: "10px 12px",
    borderRadius: 10,
    fontSize: 14,
    lineHeight: 1.2,
  },

  // ✅ NOVO: wrapper para dar “respiro” entre label e campo
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },

  // ✅ NOVO: botão discreto (já existia, mantive)
  linkBtn: {
    border: "none",
    background: "transparent",
    padding: 0,
    fontSize: 12,
    fontWeight: 800,
    color: "#0d6efd",
    cursor: "pointer",
    textDecoration: "underline",
  },

  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.55)",
    zIndex: 2000,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "8vh 12px 12px",
  },
  dialog: { width: "100%", maxWidth: 720 },
  dialogWide: { width: "min(1200px, 96vw)" },
  content: {
    background: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,.08)",
    boxShadow: "0 20px 60px rgba(0,0,0,.25)",
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
    justifyContent: "flex-end",
  },
  label: { fontSize: 12, fontWeight: 800, marginBottom: 6, color: "#374151" },
};
