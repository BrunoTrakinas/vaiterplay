import React from "react";

export default function AgendaBloqueiosBox({
  bloqueios = [],
  quadras = [],
  quadraSelecionadaId,
  selectedQuadraIds = [],
  setSelectedQuadraIds,
  bloquearComplexoInteiro,
  setBloquearComplexoInteiro,
  bloqueioForm,
  setBloqueioForm,
  salvandoBloqueio,
  excluindoBloqueioId,
  onSalvarBloqueio,
  onExcluirBloqueio,
  onResetForm,
}) {
  function toggleQuadra(id) {
    if (!setSelectedQuadraIds) return;
    setSelectedQuadraIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  return (
    <div className="card">
      <h3>Bloqueios da quadra</h3>

      <div style={{ marginTop: 10 }}>
        <label style={{ fontWeight: 700, fontSize: 13 }}>
          Quadras para bloquear (seleção)
        </label>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
          {quadras.map((q) => (
            <label key={q.id} style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={selectedQuadraIds.includes(q.id)}
                onChange={() => toggleQuadra(q.id)}
              />
              {q.nome_dinamico || q.nome || q.tipo || q.id}
            </label>
          ))}
        </div>

        <label style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!bloquearComplexoInteiro}
            onChange={(e) => setBloquearComplexoInteiro?.(e.target.checked)}
          />
          Bloquear complexo inteiro (usar seleção acima)
        </label>
      </div>

      <form
        style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          onSalvarBloqueio?.();
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Data</label>
          <input
            value={bloqueioForm?.data ?? ""}
            onChange={(e) => setBloqueioForm?.((p) => ({ ...p, data: e.target.value }))}
            placeholder="YYYY-MM-DD"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Motivo</label>
          <input
            value={bloqueioForm?.motivo ?? ""}
            onChange={(e) => setBloqueioForm?.((p) => ({ ...p, motivo: e.target.value }))}
            placeholder="Ex: manutenção"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Hora início (opcional)</label>
          <input
            value={bloqueioForm?.horaInicio ?? ""}
            onChange={(e) => setBloqueioForm?.((p) => ({ ...p, horaInicio: e.target.value }))}
            placeholder="18:00"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontWeight: 700, fontSize: 13 }}>Hora fim (opcional)</label>
          <input
            value={bloqueioForm?.horaFim ?? ""}
            onChange={(e) => setBloqueioForm?.((p) => ({ ...p, horaFim: e.target.value }))}
            placeholder="23:00"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />
        </div>

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn btn-success" type="submit" disabled={salvandoBloqueio}>
            {salvandoBloqueio ? "Salvando..." : "Salvar bloqueio"}
          </button>

          <button className="btn btn-outline-secondary" type="button" onClick={onResetForm}>
            Limpar
          </button>
        </div>
      </form>

      <div style={{ marginTop: 14 }}>
        <h4 style={{ margin: 0 }}>Bloqueios cadastrados</h4>

        {(!bloqueios || bloqueios.length === 0) && (
          <p style={{ marginTop: 8, fontSize: 13, opacity: 0.75 }}>Nenhum bloqueio cadastrado.</p>
        )}

        {bloqueios?.map((b) => (
          <div
            key={b.id}
            style={{
              marginTop: 10,
              border: "1px solid #e6e6e6",
              borderRadius: 10,
              padding: 10,
              background: "#fff",
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 800 }}>
                {String(b.data).slice(0, 10)}{" "}
                {b.hora_inicio && b.hora_fim
                  ? `— ${(b.hora_inicio || "").slice(0, 5)} → ${(b.hora_fim || "").slice(0, 5)}`
                  : "— DIA INTEIRO"}
              </div>
              <div style={{ opacity: 0.8 }}>{b.motivo || "—"}</div>
            </div>

            <button
              className="btn btn-danger"
              type="button"
              disabled={excluindoBloqueioId === b.id}
              onClick={() => onExcluirBloqueio?.(b.id)}
            >
              {excluindoBloqueioId === b.id ? "Excluindo..." : "Excluir"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
