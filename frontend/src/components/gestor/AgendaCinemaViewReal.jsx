import React, { useEffect, useState } from "react";
import api from "../../services/api";
import { AgendaFilters } from "../agenda/AgendaFilters";
import { AgendaLegend } from "../agenda/AgendaLegend";
import { AgendaGrid } from "../agenda/AgendaGrid";

function AgendaCinemaViewReal({ quadraId, mode = "GESTOR" }) {
  const [periodo, setPeriodo] = useState("semana");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("todas");

  const [dias, setDias] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  async function buscarSlots() {
    if (!quadraId) return;

    try {
      setCarregando(true);
      setErro("");

      const rota =
        mode === "ADMIN"
          ? "/admin/agenda/slots"
          : "/gestor/agenda/slots";

      const { data } = await api.get(rota, {
        params: {
          quadraId,
          periodo,
          dataInicio: dataInicio || undefined,
          dataFim: dataFim || undefined,
          filtro: filtroStatus,
        },
      });

      /**
       * Backend retorna:
       * {
       *   dias: [
       *     {
       *       data: "YYYY-MM-DD",
       *       slots: [...]
       *     }
       *   ]
       * }
       */
      const diasFormatados = (data.dias || []).map((d) => ({
        id: d.data,
        label: new Date(d.data).toLocaleDateString("pt-BR", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        }),
        slots: d.slots.map((s) => ({
          hora: s.hora_inicio,
          status: s.status.toLowerCase(),
          descricao:
            s.reserva
              ? `${s.reserva.user_cpf || "Reserva"}`
              : s.bloqueio
              ? s.bloqueio.motivo || "Bloqueado"
              : "Livre",
        })),
      }));

      setDias(diasFormatados);
    } catch (err) {
      console.error("[AGENDA/CINEMA] Erro ao buscar slots:", err);
      setErro(
        err.response?.data?.error ||
          "Erro ao carregar agenda tipo cinema."
      );
      setDias([]);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    if (quadraId) {
      buscarSlots();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quadraId]);

  function handleLimparFiltros() {
    setPeriodo("semana");
    setDataInicio("");
    setDataFim("");
    setFiltroStatus("todas");
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Visão geral da agenda (estilo cinema)</h3>

      {!quadraId && (
        <p style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
          Selecione uma quadra acima para visualizar a agenda tipo cinema.
        </p>
      )}

      {quadraId && (
        <>
          <AgendaFilters
            periodo={periodo}
            onPeriodoChange={setPeriodo}
            dataInicio={dataInicio}
            onDataInicioChange={setDataInicio}
            dataFim={dataFim}
            onDataFimChange={setDataFim}
            filtroStatus={filtroStatus}
            onFiltroStatusChange={setFiltroStatus}
            onAplicar={buscarSlots}
            onLimpar={handleLimparFiltros}
          />

          <AgendaLegend />

          {carregando && <p>Carregando agenda...</p>}

          {erro && (
            <p className="form-message error" style={{ marginTop: 8 }}>
              {erro}
            </p>
          )}

          {!carregando && !erro && <AgendaGrid dias={dias} />}
        </>
      )}
    </div>
  );
}

export default AgendaCinemaViewReal;
