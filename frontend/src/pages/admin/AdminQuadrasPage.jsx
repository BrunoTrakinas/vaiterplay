// src/pages/admin/AdminQuadrasPage.jsx
import React, { useEffect, useMemo, useState } from "react";
import api from "../../services/api";

export default function AdminQuadrasPage() {
  console.log("[ADMIN/QUADRAS] componente renderizado");

  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");

  const [quadras, setQuadras] = useState([]);
  const [empresas, setEmpresas] = useState([]);

  // filtros
  const [filtroEmpresaId, setFiltroEmpresaId] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("");
  const [busca, setBusca] = useState("");

  // form (criar/editar no mesmo lugar)
  const [formAberto, setFormAberto] = useState(false);
  const [modoEdicao, setModoEdicao] = useState(false);
  const [quadraEditId, setQuadraEditId] = useState(null);

  const [form, setForm] = useState({
    empresaId: "",
    tipo: "",
    material: "",
    modalidade: "",
    aviso: "",
    informacoes: "",
    status: "ativa",
    taxa_plataforma_override: "",
  });

  const [fotos, setFotos] = useState({ foto1: null, foto2: null, foto3: null });
  const [previews, setPreviews] = useState({
    foto1: null,
    foto2: null,
    foto3: null,
  });

  // ----------------------------
// carregar dados
// ----------------------------
async function carregarTudo() {
  try {
    setCarregando(true);
    setErro("");
    setMsg("");

    // 1) empresas (para dropdown)
    // Reaproveita sua rota admin de empresas (se já existir).
    // Se você não tiver GET /admin/empresas, me avisa que eu adapto para usar /gestor/empresas + permissões.
    const respEmp = await api.get("/admin/empresas");
    setEmpresas(respEmp.data || []);

    // 2) quadras
    const respQ = await api.get("/admin/quadras");
    setQuadras(respQ.data || []);
  } catch (e) {
    console.error("[ADMIN/QUADRAS] Erro ao carregar:", e);
    setErro(e.response?.data?.error || "Erro ao carregar quadras (admin).");
  } finally {
    setCarregando(false);
  }
}

useEffect(() => {
  carregarTudo();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// ✅ NOVO: fechar modal com ESC
useEffect(() => {
  function onKeyDown(e) {
    if (e.key === "Escape" && formAberto) {
      setFormAberto(false);
      limparForm();
    }
  }

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [formAberto]);

// ----------------------------
// helpers form
// ----------------------------

  function limparForm() {
    setModoEdicao(false);
    setQuadraEditId(null);
    setForm({
      empresaId: "",
      tipo: "",
      material: "",
      modalidade: "",
      aviso: "",
      informacoes: "",
      status: "ativa",
      taxa_plataforma_override: "",
    });
    setFotos({ foto1: null, foto2: null, foto3: null });
    setPreviews({ foto1: null, foto2: null, foto3: null });
  }

  function abrirNova() {
    limparForm();
    setFormAberto(true);
  }

  function abrirEdicao(quadra) {
    setMsg("");
    setErro("");

    setModoEdicao(true);
    setQuadraEditId(quadra.id);

    setForm({
      empresaId: quadra.empresa_id || "",
      tipo: quadra.tipo || "",
      material: quadra.material || "",
      modalidade: quadra.modalidade || "",
      aviso: quadra.aviso || "",
      informacoes: quadra.informacoes || "",
      status: quadra.status || "ativa",
      taxa_plataforma_override:
        quadra.taxa_plataforma_override == null ? "" : String(quadra.taxa_plataforma_override),
    });

    // previews das imagens atuais
    setPreviews({
      foto1: quadra.url_imagem_header || null,
      foto2: quadra.url_imagem_2 || null,
      foto3: quadra.url_imagem_3 || null,
    });

    setFotos({ foto1: null, foto2: null, foto3: null });
    setFormAberto(true);
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleFileChange(e, key) {
    const file = e.target.files?.[0] || null;
    setFotos((prev) => ({ ...prev, [key]: file }));

    if (file) {
      const url = URL.createObjectURL(file);
      setPreviews((prev) => ({ ...prev, [key]: url }));
    }
  }

  // ----------------------------
  // salvar (criar/editar)
  // ----------------------------
  async function salvar(e) {
    e.preventDefault();
    setErro("");
    setMsg("");

    if (!form.empresaId) {
      setErro("Selecione a empresa/complexo antes de salvar.");
      return;
    }
    if (!form.tipo || !form.material || !form.modalidade) {
      setErro("Campos obrigatórios: Tipo, Material e Modalidade.");
      return;
    }

    try {
      setCarregando(true);

      if (!modoEdicao) {
        // CREATE (form-data) para já enviar fotos
        const fd = new FormData();
        fd.append("empresaId", form.empresaId);
        fd.append("tipo", form.tipo);
        fd.append("material", form.material);
        fd.append("modalidade", form.modalidade);
        fd.append("aviso", form.aviso || "");
        fd.append("informacoes", form.informacoes || "");
        fd.append("status", form.status || "ativa");
        fd.append("taxa_plataforma_override", form.taxa_plataforma_override || "");

        if (fotos.foto1) fd.append("foto1", fotos.foto1);
        if (fotos.foto2) fd.append("foto2", fotos.foto2);
        if (fotos.foto3) fd.append("foto3", fotos.foto3);

        await api.post("/admin/quadras", fd);
        setMsg("Quadra criada com sucesso!");
      } else {
        // EDIT (JSON) + (opcional) fotos
        const payload = {
          empresa_id: form.empresaId,
          tipo: form.tipo,
          material: form.material,
          modalidade: form.modalidade,
          aviso: form.aviso,
          informacoes: form.informacoes,
          status: form.status,
          taxa_plataforma_override: form.taxa_plataforma_override,
        };

        await api.put(`/admin/quadras/${quadraEditId}`, payload);

        if (fotos.foto1 || fotos.foto2 || fotos.foto3) {
          const fd = new FormData();
          if (fotos.foto1) fd.append("foto1", fotos.foto1);
          if (fotos.foto2) fd.append("foto2", fotos.foto2);
          if (fotos.foto3) fd.append("foto3", fotos.foto3);

          await api.put(`/admin/quadras/${quadraEditId}/fotos`, fd);
        }

        setMsg("Quadra atualizada com sucesso!");
      }

      await carregarTudo();
      setFormAberto(false);
      limparForm();
    } catch (err) {
      console.error("[ADMIN/QUADRAS] Erro ao salvar:", err);
      setErro(err.response?.data?.error || "Erro ao salvar quadra.");
    } finally {
      setCarregando(false);
    }
  }

  // ----------------------------
  // ações status/excluir
  // ----------------------------
  async function toggleStatus(quadra) {
    try {
      setErro("");
      setMsg("");

      const statusLower = String(quadra.status || "").toLowerCase();
      const estaAtiva = statusLower === "ativa";

      const rota = estaAtiva
        ? `/admin/quadras/${quadra.id}/desativar`
        : `/admin/quadras/${quadra.id}/reativar`;

      await api.patch(rota, estaAtiva ? { motivo: "Bloqueada pelo Admin" } : undefined);
      await carregarTudo();
    } catch (err) {
      console.error("[ADMIN/QUADRAS] Erro ao alterar status:", err);
      setErro(err.response?.data?.error || "Erro ao alterar status.");
    }
  }

  async function excluirSoft(quadra) {
    const ok = window.confirm(
      `Confirma excluir (soft delete) a quadra "${quadra.tipo || "Quadra"}"?`
    );
    if (!ok) return;

    try {
      setErro("");
      setMsg("");
      await api.delete(`/admin/quadras/${quadra.id}`);
      await carregarTudo();
      setMsg("Quadra excluída (soft delete).");
    } catch (err) {
      console.error("[ADMIN/QUADRAS] Erro ao excluir:", err);
      setErro(err.response?.data?.error || "Erro ao excluir quadra.");
    }
  }

  // ----------------------------
  // filtros + agrupamento por empresa
  // ----------------------------
  const quadrasFiltradas = useMemo(() => {
    const b = (busca || "").trim().toLowerCase();

    return (quadras || []).filter((q) => {
      if (filtroEmpresaId && q.empresa_id !== filtroEmpresaId) return false;
      if (filtroStatus && String(q.status || "").toLowerCase() !== filtroStatus) return false;

      if (b) {
        const s =
          `${q.tipo || ""} ${q.material || ""} ${q.modalidade || ""}`.toLowerCase();
        if (!s.includes(b)) return false;
      }

      return true;
    });
  }, [quadras, filtroEmpresaId, filtroStatus, busca]);

  const empresasMap = useMemo(() => {
    const m = new Map();
    (empresas || []).forEach((e) => m.set(e.id, e));
    return m;
  }, [empresas]);

  const quadrasPorEmpresa = useMemo(() => {
    const map = new Map();

    quadrasFiltradas.forEach((q) => {
      const empId = q.empresa_id || "SEM_EMPRESA";
      if (!map.has(empId)) map.set(empId, []);
      map.get(empId).push(q);
    });

    // transforma em array com dados da empresa
    const arr = Array.from(map.entries()).map(([empresaId, lista]) => {
      const emp = empresasMap.get(empresaId) || qEmpresaFallback(empresaId);
      return { empresaId, empresa: emp, quadras: lista };
    });

    // ordena por nome empresa
    arr.sort((a, b) => String(a.empresa?.nome || "").localeCompare(String(b.empresa?.nome || "")));
    return arr;
  }, [quadrasFiltradas, empresasMap]);

  function qEmpresaFallback(empresaId) {
    if (empresaId === "SEM_EMPRESA") return { id: "SEM_EMPRESA", nome: "Sem empresa" };
    return { id: empresaId, nome: "Empresa não carregada" };
  }

  function labelStatus(status) {
    const s = String(status || "").toLowerCase();
    if (s === "ativa") return "Ativa";
    if (s === "inativa") return "Inativa";
    if (s === "manutencao") return "Em manutenção";
    if (s === "excluida") return "Excluída";
    return "—";
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Quadras (Admin)</h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            Visão global: todas as quadras de todas as empresas/gestores.
          </p>
        </div>

        <button className="btn-primary" onClick={abrirNova}>
          + Nova quadra
        </button>
      </div>

      {/* Filtros */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.75 }}>Empresa</label>
            <select
              value={filtroEmpresaId}
              onChange={(e) => setFiltroEmpresaId(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #ddd", minWidth: 240 }}
            >
              <option value="">Todas</option>
              {(empresas || []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, opacity: 0.75 }}>Status</label>
            <select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #ddd", minWidth: 180 }}
            >
              <option value="">Todos</option>
              <option value="ativa">Ativa</option>
              <option value="inativa">Inativa</option>
              <option value="manutencao">Manutenção</option>
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <label style={{ fontSize: 12, opacity: 0.75 }}>Busca</label>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="tipo, material, modalidade..."
              style={{ padding: 8, borderRadius: 8, border: "1px solid #ddd" }}
            />
          </div>
        </div>
      </div>

      {carregando && <p>Carregando...</p>}
      {erro && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {erro}
        </div>
      )}
      {msg && (
        <div className="alert" style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {!carregando && quadrasFiltradas.length === 0 && (
        <p>Nenhuma quadra encontrada com os filtros atuais.</p>
      )}

      {!carregando && quadrasFiltradas.length > 0 && (
        <div className="quadras-por-empresa-wrapper">
          {quadrasPorEmpresa.map((grupo) => (
            <div key={grupo.empresaId} className="empresa-bloco">
              <div className="empresa-header">
                <h2 className="empresa-nome">{grupo.empresa?.nome || "Empresa"}</h2>
                {grupo.empresa && grupo.empresa.endereco_resumo && (
                  <p className="empresa-endereco">{grupo.empresa.endereco_resumo}</p>
                )}

              </div>

              <div className="quadras-grid">
                {grupo.quadras.map((q) => {
                  const s = String(q.status || "").toLowerCase();
                  const badgeClass =
                    s === "ativa"
                      ? "quadra-status-ativa"
                      : s === "inativa"
                      ? "quadra-status-inativa"
                      : s === "manutencao"
                      ? "quadra-status-manutencao"
                      : "";

                  return (
                    <div key={q.id} className="card quadra-card">
                      <div className="quadra-card-header">
                        <div>
                          <h3 className="quadra-nome">
                            {q.tipo || "Quadra"}{" "}
                            {q.modalidade ? `- ${q.modalidade}` : ""}
                          </h3>
                          <span className="quadra-material">
                            {q.material || "Material não informado"}
                          </span>
                        </div>

                        <span className={`quadra-status-badge ${badgeClass}`}>
                          {labelStatus(q.status)}
                        </span>
                      </div>

                      <div className="quadra-detalhes">
                        {q.informacoes && (
                          <p>
                            <strong>Informações:</strong> {q.informacoes}
                          </p>
                        )}
                        {q.aviso && (
                          <p>
                            <strong>Aviso:</strong> {q.aviso}
                          </p>
                        )}

                        <p style={{ marginTop: 6 }}>
                          <strong>Taxa override:</strong>{" "}
                          {q.taxa_plataforma_override == null
                            ? "— (usa taxa global do Gestor)"
                            : `${q.taxa_plataforma_override}`}
                        </p>
                      </div>

                      <div className="quadra-acoes">
                        <button
                          className="btn-outlined"
                          type="button"
                          onClick={() => abrirEdicao(q)}
                        >
                          Editar
                        </button>

                        <button
                          className="btn-outlined"
                          type="button"
                          onClick={() => toggleStatus(q)}
                        >
                          {String(q.status || "").toLowerCase() === "ativa"
                            ? "Desativar"
                            : "Reativar"}
                        </button>

                        <button
                          className="btn-danger"
                          type="button"
                          onClick={() => excluirSoft(q)}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MODAL FORM (criar/editar) */}
{formAberto && (
  <div
    className="vt-modal-overlay"
    onClick={() => {
      setFormAberto(false);
      limparForm();
    }}
  >
    <div
      className="vt-modal"
      onClick={(e) => e.stopPropagation()} // não fecha ao clicar dentro
    >
      <div className="vt-modal-header">
        <div>
          <h2 style={{ margin: 0 }}>
            {modoEdicao ? "Editar quadra (Admin)" : "Nova quadra (Admin)"}
          </h2>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
            {modoEdicao
              ? "Edite os dados da quadra e salve."
              : "Cadastre a nova quadra e salve."}
          </p>
        </div>

        <button
          className="vt-modal-close"
          type="button"
          onClick={() => {
            setFormAberto(false);
            limparForm();
          }}
          aria-label="Fechar"
          title="Fechar"
        >
          ✕
        </button>
      </div>

      <div className="vt-modal-body">
        <form onSubmit={salvar}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>Empresa *</label>
              <select
                name="empresaId"
                value={form.empresaId}
                onChange={handleChange}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              >
                <option value="">Selecione...</option>
                {(empresas || []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nome}
                  </option>
                ))}
              </select>
              <small style={{ opacity: 0.75 }}>
                O Gestor é inferido automaticamente pela empresa selecionada.
              </small>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>Status</label>
              <select
                name="status"
                value={form.status}
                onChange={handleChange}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              >
                <option value="ativa">Ativa</option>
                <option value="inativa">Inativa</option>
                <option value="manutencao">Manutenção</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>Tipo *</label>
              <input
                name="tipo"
                value={form.tipo}
                onChange={handleChange}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>Material *</label>
              <input
                name="material"
                value={form.material}
                onChange={handleChange}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>Modalidade *</label>
              <input
                name="modalidade"
                value={form.modalidade}
                onChange={handleChange}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontWeight: 700, fontSize: 13 }}>
                Taxa override (opcional)
              </label>
              <input
                name="taxa_plataforma_override"
                value={form.taxa_plataforma_override}
                onChange={handleChange}
                placeholder="ex: 10 (ou 0)"
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
              <small style={{ opacity: 0.75 }}>
                Se preenchida, sobrescreve a taxa global do Gestor.
              </small>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
              marginTop: 14,
            }}
          >
            <div className="photo-slot">
              <span className="photo-label">Foto 1</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleFileChange(e, "foto1")}
              />
              {previews.foto1 && (
                <img
                  src={previews.foto1}
                  alt="Prévia foto 1"
                  className="photo-preview"
                />
              )}
            </div>

            <div className="photo-slot">
              <span className="photo-label">Foto 2</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleFileChange(e, "foto2")}
              />
              {previews.foto2 && (
                <img
                  src={previews.foto2}
                  alt="Prévia foto 2"
                  className="photo-preview"
                />
              )}
            </div>

            <div className="photo-slot">
              <span className="photo-label">Foto 3</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleFileChange(e, "foto3")}
              />
              {previews.foto3 && (
                <img
                  src={previews.foto3}
                  alt="Prévia foto 3"
                  className="photo-preview"
                />
              )}
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              display: "flex",
              gap: 10,
              justifyContent: "flex-end",
            }}
          >
            <button
              className="btn-outlined"
              type="button"
              onClick={limparForm}
              disabled={carregando}
            >
              Limpar
            </button>
            <button className="btn-primary" type="submit" disabled={carregando}>
              {carregando ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
)}

    </div>
  );
}
