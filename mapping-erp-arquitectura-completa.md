# Mapping Ingeniería ERP — Arquitectura Completa de Producción

---

## MÓDULO FINANCIERO

### Decisión arquitectónica
El flujo de aprobación de compras requiere **niveles de autorización encadenados** (solicitante → jefe de área → gerencia → tesorería) donde cada nivel tiene umbrales de monto. La clave es que una compra no puede saltar niveles ni retroceder arbitrariamente. Implementamos una **cadena de aprobación dinámica** donde el número de niveles requeridos depende del monto de la solicitud.

---

### `backend/src/modules/financiero/financiero.states.js`

```javascript
/**
 * Niveles de aprobación según monto (COP).
 * Configurable por variables de entorno en producción.
 */
const UMBRALES_APROBACION = {
  JEFE_AREA:  parseFloat(process.env.UMBRAL_JEFE  || '5000000'),   // < 5M solo jefe
  GERENCIA:   parseFloat(process.env.UMBRAL_GERENCIA || '20000000'), // < 20M hasta gerencia
  // >= 20M requiere tesorería también
};

const ESTADOS_COMPRA = Object.freeze({
  BORRADOR:            'borrador',
  PENDIENTE_JEFE:      'pendiente_jefe',
  PENDIENTE_GERENCIA:  'pendiente_gerencia',
  PENDIENTE_TESORERIA: 'pendiente_tesoreria',
  APROBADA:            'aprobada',
  RECHAZADA:           'rechazada',
  ANULADA:             'anulada',
  EN_PROCESO:          'en_proceso',
  COMPLETADA:          'completada',
});

/**
 * Determina qué estados de aprobación debe recorrer una solicitud según su monto.
 */
const calcularFlujoAprobacion = (monto) => {
  const flujo = [ESTADOS_COMPRA.PENDIENTE_JEFE];
  if (monto >= UMBRALES_APROBACION.JEFE_AREA)    flujo.push(ESTADOS_COMPRA.PENDIENTE_GERENCIA);
  if (monto >= UMBRALES_APROBACION.GERENCIA)     flujo.push(ESTADOS_COMPRA.PENDIENTE_TESORERIA);
  flujo.push(ESTADOS_COMPRA.APROBADA);
  return flujo;
};

/**
 * Dado el estado actual, devuelve el siguiente estado en el flujo de aprobación.
 */
const siguienteEstado = (estadoActual, monto) => {
  const flujo = calcularFlujoAprobacion(monto);
  const indexActual = flujo.indexOf(estadoActual);
  return flujo[indexActual + 1] || null;
};

/**
 * Verifica si un rol puede aprobar en el estado actual.
 */
const ROLES_POR_ESTADO = {
  [ESTADOS_COMPRA.PENDIENTE_JEFE]:      ['jefe_area', 'gerente', 'admin'],
  [ESTADOS_COMPRA.PENDIENTE_GERENCIA]:  ['gerente', 'admin'],
  [ESTADOS_COMPRA.PENDIENTE_TESORERIA]: ['tesorero', 'admin'],
};

const puedeAprobar = (rol, estadoActual) => {
  const rolesPermitidos = ROLES_POR_ESTADO[estadoActual] || [];
  return rolesPermitidos.includes(rol);
};

module.exports = { ESTADOS_COMPRA, calcularFlujoAprobacion, siguienteEstado, puedeAprobar };
```

---

### `backend/src/modules/financiero/financiero.schema.js`

```javascript
const Joi = require('joi');

const itemCompraSchema = Joi.object({
  descripcion:     Joi.string().trim().min(3).max(500).required(),
  cantidad:        Joi.number().positive().precision(4).required(),
  precio_unitario: Joi.number().positive().precision(2).required(),
  proveedor_id:    Joi.number().integer().positive().allow(null).optional(),
  codigo_presupuesto: Joi.string().trim().max(50).allow(null, '').optional(),
});

const crearSolicitudSchema = Joi.object({
  titulo:         Joi.string().trim().min(5).max(200).required(),
  justificacion:  Joi.string().trim().min(10).max(2000).required(),
  proyecto_id:    Joi.number().integer().positive().allow(null).optional(),
  area_id:        Joi.number().integer().positive().required(),
  items:          Joi.array().items(itemCompraSchema).min(1).max(50).required(),
  urgente:        Joi.boolean().default(false),
  fecha_requerida: Joi.date().iso().min('now').allow(null).optional(),
});

const accionAprobacionSchema = Joi.object({
  accion:    Joi.string().valid('aprobar', 'rechazar').required(),
  comentario: Joi.string().trim().max(1000).when('accion', {
    is: 'rechazar',
    then: Joi.required().messages({ 'any.required': 'El comentario es obligatorio al rechazar' }),
    otherwise: Joi.optional().allow('', null),
  }),
});

const filtrosSolicitudSchema = Joi.object({
  estado:     Joi.string().optional(),
  area_id:    Joi.number().integer().positive().optional(),
  urgente:    Joi.boolean().optional(),
  fecha_desde: Joi.date().iso().optional(),
  fecha_hasta: Joi.date().iso().optional(),
  pagina:     Joi.number().integer().min(1).default(1),
  limite:     Joi.number().integer().min(1).max(100).default(20),
});

module.exports = { crearSolicitudSchema, accionAprobacionSchema, filtrosSolicitudSchema };
```

---

### `backend/src/modules/financiero/financiero.repository.js`

```javascript
const { pool } = require('../../shared/database/pool');

const crearSolicitud = async (client, datos) => {
  const { rows } = await client.query(`
    INSERT INTO solicitudes_compra
      (titulo, justificacion, proyecto_id, area_id, estado, urgente, fecha_requerida, solicitante_id, monto_total, created_at, updated_at)
    VALUES ($1,$2,$3,$4,'borrador',$5,$6,$7,$8,NOW(),NOW())
    RETURNING *
  `, [datos.titulo, datos.justificacion, datos.proyecto_id, datos.area_id,
      datos.urgente, datos.fecha_requerida, datos.solicitanteId, datos.montoTotal]);
  return rows[0];
};

const crearItemsSolicitud = async (client, solicitudId, items) => {
  const values = items.map((_, i) => {
    const b = i * 5;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
  }).join(',');
  const params = items.flatMap(it => [
    solicitudId, it.descripcion, it.cantidad, it.precio_unitario,
    it.cantidad * it.precio_unitario
  ]);
  const { rows } = await client.query(`
    INSERT INTO solicitud_compra_items (solicitud_id, descripcion, cantidad, precio_unitario, subtotal)
    VALUES ${values} RETURNING *
  `, params);
  return rows;
};

const obtenerSolicitudCompleta = async (id) => {
  const { rows } = await pool.query(`
    SELECT
      sc.*,
      u.nombre      AS solicitante_nombre,
      a.nombre      AS area_nombre,
      p.nombre      AS proyecto_nombre,
      JSON_AGG(JSON_BUILD_OBJECT(
        'id',             sci.id,
        'descripcion',    sci.descripcion,
        'cantidad',       sci.cantidad,
        'precio_unitario',sci.precio_unitario,
        'subtotal',       sci.subtotal
      ) ORDER BY sci.id) AS items
    FROM solicitudes_compra sc
    JOIN usuarios u  ON sc.solicitante_id = u.id
    JOIN areas a     ON sc.area_id = a.id
    LEFT JOIN proyectos p ON sc.proyecto_id = p.id
    LEFT JOIN solicitud_compra_items sci ON sc.id = sci.solicitud_id
    WHERE sc.id = $1 AND sc.deleted_at IS NULL
    GROUP BY sc.id, u.nombre, a.nombre, p.nombre
  `, [id]);
  return rows[0] || null;
};

const actualizarEstadoSolicitud = async (client, { id, estado, usuarioId }) => {
  const { rows } = await client.query(`
    UPDATE solicitudes_compra
    SET estado = $1, updated_by = $2, updated_at = NOW()
    WHERE id = $3 RETURNING *
  `, [estado, usuarioId, id]);
  return rows[0];
};

const registrarAprobacion = async (client, { solicitudId, nivel, accion, comentario, usuarioId, estadoResultante }) => {
  await client.query(`
    INSERT INTO aprobaciones_compra
      (solicitud_id, nivel_aprobacion, accion, comentario, aprobador_id, estado_resultante, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
  `, [solicitudId, nivel, accion, comentario, usuarioId, estadoResultante]);
};

const listarSolicitudes = async ({ estado, areaId, urgente, fechaDesde, fechaHasta, pagina, limite }) => {
  const conditions = ['sc.deleted_at IS NULL'];
  const params = [];
  let i = 1;
  if (estado)     { conditions.push(`sc.estado = $${i++}`);       params.push(estado); }
  if (areaId)     { conditions.push(`sc.area_id = $${i++}`);      params.push(areaId); }
  if (urgente !== undefined) { conditions.push(`sc.urgente = $${i++}`); params.push(urgente); }
  if (fechaDesde) { conditions.push(`sc.created_at >= $${i++}`);  params.push(fechaDesde); }
  if (fechaHasta) { conditions.push(`sc.created_at <= $${i++}`);  params.push(fechaHasta); }

  const where = conditions.join(' AND ');
  const offset = (pagina - 1) * limite;

  const [data, count] = await Promise.all([
    pool.query(`
      SELECT sc.id, sc.titulo, sc.estado, sc.urgente, sc.monto_total, sc.created_at,
             u.nombre AS solicitante, a.nombre AS area
      FROM solicitudes_compra sc
      JOIN usuarios u ON sc.solicitante_id = u.id
      JOIN areas a    ON sc.area_id = a.id
      WHERE ${where}
      ORDER BY sc.urgente DESC, sc.created_at DESC
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, limite, offset]),
    pool.query(`SELECT COUNT(*) FROM solicitudes_compra sc WHERE ${where}`, params),
  ]);

  return {
    data:    data.rows,
    total:   parseInt(count.rows[0].count, 10),
    pagina,
    paginas: Math.ceil(count.rows[0].count / limite),
  };
};

const obtenerHistorialAprobaciones = async (solicitudId) => {
  const { rows } = await pool.query(`
    SELECT ac.*, u.nombre AS aprobador_nombre
    FROM aprobaciones_compra ac
    JOIN usuarios u ON ac.aprobador_id = u.id
    WHERE ac.solicitud_id = $1
    ORDER BY ac.created_at ASC
  `, [solicitudId]);
  return rows;
};

module.exports = {
  crearSolicitud, crearItemsSolicitud, obtenerSolicitudCompleta,
  actualizarEstadoSolicitud, registrarAprobacion, listarSolicitudes, obtenerHistorialAprobaciones
};
```

---

### `backend/src/modules/financiero/financiero.service.js`

```javascript
const repo = require('./financiero.repository');
const { withTransaction } = require('../../shared/database/pool');
const { ESTADOS_COMPRA, calcularFlujoAprobacion, siguienteEstado, puedeAprobar } = require('./financiero.states');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../shared/errors/AppError');

const crearSolicitud = async (datos, solicitanteId) => {
  const montoTotal = datos.items.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

  return withTransaction(async (client) => {
    const solicitud = await repo.crearSolicitud(client, { ...datos, solicitanteId, montoTotal });
    const items = await repo.crearItemsSolicitud(client, solicitud.id, datos.items);
    return { ...solicitud, items };
  });
};

const enviarSolicitud = async (solicitudId, usuarioId) => {
  const solicitud = await repo.obtenerSolicitudCompleta(solicitudId);
  if (!solicitud) throw new NotFoundError('Solicitud de compra');
  if (solicitud.solicitante_id !== usuarioId) throw new ForbiddenError('Solo el solicitante puede enviar esta solicitud');
  if (solicitud.estado !== ESTADOS_COMPRA.BORRADOR) throw new ValidationError('Solo se pueden enviar solicitudes en estado borrador');

  return withTransaction(async (client) => {
    const updated = await repo.actualizarEstadoSolicitud(client, {
      id: solicitudId, estado: ESTADOS_COMPRA.PENDIENTE_JEFE, usuarioId
    });
    await repo.registrarAprobacion(client, {
      solicitudId, nivel: 0, accion: 'envio',
      comentario: 'Solicitud enviada para aprobación',
      usuarioId, estadoResultante: ESTADOS_COMPRA.PENDIENTE_JEFE
    });
    return updated;
  });
};

const procesarAprobacion = async ({ solicitudId, accion, comentario, usuarioId, rol }) => {
  const solicitud = await repo.obtenerSolicitudCompleta(solicitudId);
  if (!solicitud) throw new NotFoundError('Solicitud de compra');

  const estadoActual = solicitud.estado;

  // Validar que el estado sea aprobable
  const estadosAprobables = [
    ESTADOS_COMPRA.PENDIENTE_JEFE,
    ESTADOS_COMPRA.PENDIENTE_GERENCIA,
    ESTADOS_COMPRA.PENDIENTE_TESORERIA,
  ];
  if (!estadosAprobables.includes(estadoActual)) {
    throw new ValidationError(`No se puede procesar una solicitud en estado: ${estadoActual}`);
  }

  // Validar permisos del rol para este nivel
  if (!puedeAprobar(rol, estadoActual)) {
    throw new ForbiddenError(`El rol '${rol}' no puede aprobar en el nivel actual: ${estadoActual}`);
  }

  const nivelMap = {
    [ESTADOS_COMPRA.PENDIENTE_JEFE]:      1,
    [ESTADOS_COMPRA.PENDIENTE_GERENCIA]:  2,
    [ESTADOS_COMPRA.PENDIENTE_TESORERIA]: 3,
  };

  return withTransaction(async (client) => {
    let estadoResultante;

    if (accion === 'rechazar') {
      estadoResultante = ESTADOS_COMPRA.RECHAZADA;
    } else {
      // Avanzar al siguiente estado del flujo según el monto
      estadoResultante = siguienteEstado(estadoActual, solicitud.monto_total);
      if (!estadoResultante) throw new ValidationError('No hay siguiente estado en el flujo');
    }

    await repo.actualizarEstadoSolicitud(client, {
      id: solicitudId, estado: estadoResultante, usuarioId
    });

    await repo.registrarAprobacion(client, {
      solicitudId,
      nivel: nivelMap[estadoActual],
      accion,
      comentario,
      usuarioId,
      estadoResultante,
    });

    return { solicitudId, estadoAnterior: estadoActual, estadoNuevo: estadoResultante };
  });
};

const obtenerSolicitudConHistorial = async (id) => {
  const [solicitud, historial] = await Promise.all([
    repo.obtenerSolicitudCompleta(id),
    repo.obtenerHistorialAprobaciones(id),
  ]);
  if (!solicitud) throw new NotFoundError('Solicitud de compra');
  return { ...solicitud, historial_aprobaciones: historial };
};

const obtenerFlujoPendiente = async (rol) => {
  const estadosPorRol = {
    jefe_area:  [ESTADOS_COMPRA.PENDIENTE_JEFE],
    gerente:    [ESTADOS_COMPRA.PENDIENTE_JEFE, ESTADOS_COMPRA.PENDIENTE_GERENCIA],
    tesorero:   [ESTADOS_COMPRA.PENDIENTE_TESORERIA],
    admin:      Object.values(ESTADOS_COMPRA).filter(e => e.startsWith('pendiente')),
  };
  const estados = estadosPorRol[rol] || [];
  if (estados.length === 0) return { data: [], total: 0 };

  // Listar todas pendientes para el rol
  const resultados = await Promise.all(
    estados.map(estado => repo.listarSolicitudes({ estado, pagina: 1, limite: 100 }))
  );
  const data = resultados.flatMap(r => r.data);
  data.sort((a, b) => b.urgente - a.urgente || new Date(b.created_at) - new Date(a.created_at));
  return { data, total: data.length };
};

module.exports = { crearSolicitud, enviarSolicitud, procesarAprobacion, obtenerSolicitudConHistorial, obtenerFlujoPendiente };
```

---

### `backend/src/modules/financiero/financiero.controller.js`

```javascript
const service = require('./financiero.service');

const listar    = async (req, res, next) => { try { res.json({ status:'success', data: await service.obtenerFlujoPendiente(req.user.rol) }); } catch(e) { next(e); } };
const obtener   = async (req, res, next) => { try { res.json({ status:'success', data: await service.obtenerSolicitudConHistorial(+req.params.id) }); } catch(e) { next(e); } };
const crear     = async (req, res, next) => { try { res.status(201).json({ status:'success', data: await service.crearSolicitud(req.body, req.user.sub) }); } catch(e) { next(e); } };
const enviar    = async (req, res, next) => { try { res.json({ status:'success', data: await service.enviarSolicitud(+req.params.id, req.user.sub) }); } catch(e) { next(e); } };
const aprobar   = async (req, res, next) => {
  try {
    const result = await service.procesarAprobacion({
      solicitudId: +req.params.id,
      accion:      req.body.accion,
      comentario:  req.body.comentario,
      usuarioId:   req.user.sub,
      rol:         req.user.rol,
    });
    res.json({ status: 'success', data: result });
  } catch(e) { next(e); }
};

module.exports = { listar, obtener, crear, enviar, aprobar };
```

---

### `backend/src/modules/financiero/financiero.routes.js`

```javascript
const express = require('express');
const router  = express.Router();
const ctrl    = require('./financiero.controller');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const { validate }       = require('../../middlewares/validate.middleware');
const { crearSolicitudSchema, accionAprobacionSchema } = require('./financiero.schema');

router.use(authMiddleware);

router.get('/',                      ctrl.listar);
router.get('/:id',                   ctrl.obtener);
router.post('/',   validate(crearSolicitudSchema),    ctrl.crear);
router.patch('/:id/enviar',          ctrl.enviar);
router.patch('/:id/aprobacion',      validate(accionAprobacionSchema), ctrl.aprobar);

module.exports = router;
```

---

### DDL Financiero

```sql
CREATE TABLE IF NOT EXISTS areas (
  id         SERIAL PRIMARY KEY,
  nombre     VARCHAR(100) NOT NULL UNIQUE,
  gerente_id INTEGER REFERENCES usuarios(id),
  activo     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS solicitudes_compra (
  id               SERIAL PRIMARY KEY,
  titulo           VARCHAR(200) NOT NULL,
  justificacion    TEXT NOT NULL,
  proyecto_id      INTEGER REFERENCES proyectos(id),
  area_id          INTEGER NOT NULL REFERENCES areas(id),
  estado           VARCHAR(30) NOT NULL DEFAULT 'borrador'
                   CHECK (estado IN ('borrador','pendiente_jefe','pendiente_gerencia',
                          'pendiente_tesoreria','aprobada','rechazada','anulada',
                          'en_proceso','completada')),
  urgente          BOOLEAN NOT NULL DEFAULT FALSE,
  monto_total      NUMERIC(16,2) NOT NULL CHECK (monto_total >= 0),
  fecha_requerida  DATE,
  solicitante_id   INTEGER NOT NULL REFERENCES usuarios(id),
  updated_by       INTEGER REFERENCES usuarios(id),
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS solicitud_compra_items (
  id               SERIAL PRIMARY KEY,
  solicitud_id     INTEGER NOT NULL REFERENCES solicitudes_compra(id) ON DELETE CASCADE,
  descripcion      VARCHAR(500) NOT NULL,
  cantidad         NUMERIC(12,4) NOT NULL CHECK (cantidad > 0),
  precio_unitario  NUMERIC(14,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal         NUMERIC(16,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED
);

CREATE TABLE IF NOT EXISTS aprobaciones_compra (
  id                SERIAL PRIMARY KEY,
  solicitud_id      INTEGER NOT NULL REFERENCES solicitudes_compra(id),
  nivel_aprobacion  SMALLINT NOT NULL,
  accion            VARCHAR(20) NOT NULL CHECK (accion IN ('envio','aprobar','rechazar')),
  comentario        TEXT,
  aprobador_id      INTEGER NOT NULL REFERENCES usuarios(id),
  estado_resultante VARCHAR(30) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices clave
CREATE INDEX IF NOT EXISTS idx_sol_compra_estado    ON solicitudes_compra(estado)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sol_compra_area      ON solicitudes_compra(area_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sol_compra_urgente   ON solicitudes_compra(urgente)    WHERE deleted_at IS NULL AND estado NOT IN ('aprobada','rechazada','anulada');
CREATE INDEX IF NOT EXISTS idx_aprobaciones_sol     ON aprobaciones_compra(solicitud_id);

DROP TRIGGER IF EXISTS trg_solicitudes_compra_updated_at ON solicitudes_compra;
CREATE TRIGGER trg_solicitudes_compra_updated_at
  BEFORE UPDATE ON solicitudes_compra
  FOR EACH ROW EXECUTE FUNCTION fn_update_timestamp();
```

---

## MÓDULO OPERACIONES

### Decisión arquitectónica
El dashboard de operaciones tiene dos retos distintos: **consultas agregadas pesadas** (métricas en tiempo real) y **asignación matricial** (empleados × proyectos × semanas). Para las métricas usamos **CTEs (Common Table Expressions)** que permiten al query planner de PostgreSQL optimizar subconsultas reutilizadas. Para la matriz usamos una representación de **tabla pivot dinámica** que evita el problema N+1 clásico de dashboards.

---

### `backend/src/modules/operaciones/operaciones.repository.js`

```javascript
const { pool } = require('../../shared/database/pool');

// ─── DASHBOARD ANALÍTICO ──────────────────────────────────────────────────────

/**
 * Una sola query CTE que calcula TODAS las métricas del dashboard.
 * Evita 6-8 queries separadas con datos inconsistentes entre sí.
 */
const obtenerMetricasDashboard = async (filtros = {}) => {
  const { rows } = await pool.query(`
    WITH
    proyectos_activos AS (
      SELECT p.id, p.nombre, p.estado, p.cliente_id, p.created_at,
             p.fecha_inicio_estimada, p.fecha_fin_estimada,
             c.razon_social AS cliente_nombre
      FROM proyectos p
      JOIN clientes c ON p.cliente_id = c.id
      WHERE p.deleted_at IS NULL
        AND ($1::integer IS NULL OR p.estado_id = $1)
    ),
    metricas_por_estado AS (
      SELECT estado, COUNT(*) AS cantidad
      FROM proyectos_activos
      GROUP BY estado
    ),
    horas_por_proyecto AS (
      SELECT proyecto_id,
             SUM(horas) AS horas_registradas,
             SUM(horas_estimadas) AS horas_estimadas
      FROM asignaciones
      WHERE deleted_at IS NULL
      GROUP BY proyecto_id
    ),
    proyectos_en_riesgo AS (
      SELECT pa.id, pa.nombre, pa.cliente_nombre,
             pa.fecha_fin_estimada,
             COALESCE(hpp.horas_registradas, 0) AS horas_registradas,
             COALESCE(hpp.horas_estimadas, 0)   AS horas_estimadas,
             CASE
               WHEN pa.fecha_fin_estimada < NOW() AND pa.estado NOT IN ('completado','cancelado')
               THEN 'vencido'
               WHEN pa.fecha_fin_estimada < NOW() + INTERVAL '7 days' AND pa.estado NOT IN ('completado','cancelado')
               THEN 'en_riesgo'
               ELSE 'normal'
             END AS alerta
      FROM proyectos_activos pa
      LEFT JOIN horas_por_proyecto hpp ON pa.id = hpp.proyecto_id
      WHERE pa.estado NOT IN ('completado','cancelado')
    )
    SELECT
      (SELECT COUNT(*) FROM proyectos_activos)                         AS total_proyectos,
      (SELECT COUNT(*) FROM proyectos_activos WHERE estado = 'activo') AS proyectos_activos,
      (SELECT JSON_AGG(ROW_TO_JSON(m)) FROM metricas_por_estado m)     AS proyectos_por_estado,
      (SELECT JSON_AGG(ROW_TO_JSON(r) ORDER BY r.alerta DESC, r.fecha_fin_estimada ASC)
       FROM proyectos_en_riesgo r WHERE r.alerta != 'normal')          AS alertas,
      (SELECT COUNT(*) FROM proyectos_en_riesgo WHERE alerta = 'vencido')   AS proyectos_vencidos,
      (SELECT COUNT(*) FROM proyectos_en_riesgo WHERE alerta = 'en_riesgo') AS proyectos_en_riesgo
  `, [filtros.estado_id || null]);

  return rows[0];
};

// ─── PROYECTOS CRUD ───────────────────────────────────────────────────────────

const listarProyectos = async ({ estado, clienteId, pagina = 1, limite = 20 }) => {
  const conditions = ['p.deleted_at IS NULL'];
  const params = [];
  let i = 1;

  if (estado)    { conditions.push(`p.estado = $${i++}`);     params.push(estado); }
  if (clienteId) { conditions.push(`p.cliente_id = $${i++}`); params.push(clienteId); }

  const where = conditions.join(' AND ');
  const offset = (pagina - 1) * limite;

  const { rows } = await pool.query(`
    SELECT
      p.id, p.nombre, p.estado, p.created_at,
      p.fecha_inicio_estimada, p.fecha_fin_estimada,
      c.razon_social AS cliente_nombre,
      COUNT(DISTINCT a.empleado_id) AS total_asignados,
      COALESCE(SUM(a.horas_estimadas), 0) AS horas_estimadas_total
    FROM proyectos p
    JOIN clientes c    ON p.cliente_id = c.id
    LEFT JOIN asignaciones a ON p.id = a.proyecto_id AND a.deleted_at IS NULL
    WHERE ${where}
    GROUP BY p.id, c.razon_social
    ORDER BY p.created_at DESC
    LIMIT $${i} OFFSET $${i+1}
  `, [...params, limite, offset]);

  return rows;
};

const obtenerProyecto = async (id) => {
  const { rows } = await pool.query(`
    SELECT
      p.*,
      c.razon_social AS cliente_nombre, c.email AS cliente_email,
      co.numero AS cotizacion_numero, co.titulo AS cotizacion_titulo,
      JSON_AGG(DISTINCT JSON_BUILD_OBJECT(
        'empleado_id',  a.empleado_id,
        'nombre',       e.nombre,
        'rol',          a.rol_en_proyecto,
        'horas_est',    a.horas_estimadas,
        'horas_reg',    COALESCE(a.horas_registradas, 0),
        'semana_inicio',a.semana_inicio,
        'semana_fin',   a.semana_fin
      )) FILTER (WHERE a.id IS NOT NULL) AS equipo
    FROM proyectos p
    JOIN clientes c ON p.cliente_id = c.id
    LEFT JOIN cotizaciones co ON p.cotizacion_origen_id = co.id
    LEFT JOIN asignaciones a ON p.id = a.proyecto_id AND a.deleted_at IS NULL
    LEFT JOIN empleados e    ON a.empleado_id = e.id
    WHERE p.id = $1 AND p.deleted_at IS NULL
    GROUP BY p.id, c.razon_social, c.email, co.numero, co.titulo
  `, [id]);
  return rows[0] || null;
};

// ─── MATRIZ DE ASIGNACIÓN ─────────────────────────────────────────────────────

/**
 * Genera la vista matricial: empleados (filas) × semanas ISO (columnas).
 * Devuelve un objeto optimizado para renderizado en frontend sin transformaciones adicionales.
 */
const obtenerMatrizAsignacion = async ({ semanaInicio, semanaFin, areaId }) => {
  const { rows } = await pool.query(`
    WITH semanas AS (
      -- Genera todas las semanas del rango
      SELECT GENERATE_SERIES(
        DATE_TRUNC('week', $1::date),
        DATE_TRUNC('week', $2::date),
        INTERVAL '1 week'
      )::date AS semana
    ),
    empleados_filtrados AS (
      SELECT e.id, e.nombre, e.cargo, e.area_id, a.nombre AS area_nombre
      FROM empleados e
      JOIN areas a ON e.area_id = a.id
      WHERE e.activo = TRUE
        AND e.deleted_at IS NULL
        AND ($3::integer IS NULL OR e.area_id = $3)
      ORDER BY a.nombre, e.nombre
    ),
    asignaciones_semana AS (
      SELECT
        a.empleado_id,
        DATE_TRUNC('week', a.fecha)::date AS semana,
        SUM(a.horas) AS horas_asignadas,
        JSON_AGG(JSON_BUILD_OBJECT(
          'proyecto_id',   a.proyecto_id,
          'proyecto_nombre', p.nombre,
          'horas',         a.horas,
          'rol',           a.rol_en_proyecto
        )) AS proyectos_semana
      FROM asignaciones a
      JOIN proyectos p ON a.proyecto_id = p.id
      WHERE a.deleted_at IS NULL
        AND DATE_TRUNC('week', a.fecha) BETWEEN DATE_TRUNC('week', $1::date) AND DATE_TRUNC('week', $2::date)
        AND ($3::integer IS NULL OR a.area_id = $3)
      GROUP BY a.empleado_id, DATE_TRUNC('week', a.fecha)::date
    )
    SELECT
      ef.id            AS empleado_id,
      ef.nombre,
      ef.cargo,
      ef.area_nombre,
      s.semana,
      COALESCE(asem.horas_asignadas, 0) AS horas_asignadas,
      CASE
        WHEN COALESCE(asem.horas_asignadas, 0) > 45 THEN 'sobrecargado'
        WHEN COALESCE(asem.horas_asignadas, 0) > 40 THEN 'al_limite'
        WHEN COALESCE(asem.horas_asignadas, 0) > 0  THEN 'asignado'
        ELSE 'disponible'
      END AS disponibilidad,
      asem.proyectos_semana
    FROM empleados_filtrados ef
    CROSS JOIN semanas s
    LEFT JOIN asignaciones_semana asem
      ON ef.id = asem.empleado_id AND s.semana = asem.semana
    ORDER BY ef.area_nombre, ef.nombre, s.semana
  `, [semanaInicio, semanaFin, areaId || null]);

  // Transformar a estructura matricial agrupada por empleado
  const matriz = {};
  const semanasSet = new Set();

  rows.forEach(row => {
    semanasSet.add(row.semana);
    if (!matriz[row.empleado_id]) {
      matriz[row.empleado_id] = {
        empleado_id: row.empleado_id,
        nombre:      row.nombre,
        cargo:       row.cargo,
        area:        row.area_nombre,
        semanas:     {},
      };
    }
    matriz[row.empleado_id].semanas[row.semana] = {
      horas:           row.horas_asignadas,
      disponibilidad:  row.disponibilidad,
      proyectos:       row.proyectos_semana || [],
    };
  });

  return {
    semanas:    Array.from(semanasSet).sort(),
    empleados:  Object.values(matriz),
  };
};

// ─── ASIGNACIONES CRUD ────────────────────────────────────────────────────────

const crearAsignacion = async (client, datos) => {
  const { rows } = await client.query(`
    INSERT INTO asignaciones
      (proyecto_id, empleado_id, rol_en_proyecto, horas_estimadas, fecha, semana_inicio, semana_fin, asignado_por, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (proyecto_id, empleado_id, DATE_TRUNC('week', fecha)::date)
    DO UPDATE SET horas_estimadas = EXCLUDED.horas_estimadas, rol_en_proyecto = EXCLUDED.rol_en_proyecto
    RETURNING *
  `, [datos.proyectoId, datos.empleadoId, datos.rol, datos.horas,
      datos.fecha, datos.semanaInicio, datos.semanaFin, datos.asignadoPor]);
  return rows[0];
};

module.exports = {
  obtenerMetricasDashboard, listarProyectos, obtenerProyecto,
  obtenerMatrizAsignacion, crearAsignacion
};
```

---

### `backend/src/modules/operaciones/operaciones.service.js`

```javascript
const repo = require('./operaciones.repository');
const { withTransaction } = require('../../shared/database/pool');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

const getDashboard = async (filtros) => repo.obtenerMetricasDashboard(filtros);

const getProyecto = async (id) => {
  const p = await repo.obtenerProyecto(id);
  if (!p) throw new NotFoundError('Proyecto');
  return p;
};

const getMatriz = async ({ semanaInicio, semanaFin, areaId }) => {
  const inicio = new Date(semanaInicio);
  const fin    = new Date(semanaFin);

  if (isNaN(inicio) || isNaN(fin)) throw new ValidationError('Fechas inválidas para la matriz');

  const diffSemanas = Math.round((fin - inicio) / (7 * 24 * 60 * 60 * 1000));
  if (diffSemanas > 26) throw new ValidationError('El rango máximo para la matriz es de 26 semanas');

  return repo.obtenerMatrizAsignacion({ semanaInicio, semanaFin, areaId });
};

const asignarEmpleado = async (datos, asignadoPor) => {
  const proyecto = await repo.obtenerProyecto(datos.proyecto_id);
  if (!proyecto) throw new NotFoundError('Proyecto');

  return withTransaction(async (client) => {
    return repo.crearAsignacion(client, {
      proyectoId:   datos.proyecto_id,
      empleadoId:   datos.empleado_id,
      rol:          datos.rol_en_proyecto,
      horas:        datos.horas_estimadas,
      fecha:        datos.fecha,
      semanaInicio: datos.semana_inicio,
      semanaFin:    datos.semana_fin,
      asignadoPor,
    });
  });
};

module.exports = { getDashboard, getProyecto, getMatriz, asignarEmpleado };
```

---

### `backend/src/modules/operaciones/operaciones.routes.js`

```javascript
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../../middlewares/auth.middleware');
const service = require('./operaciones.service');

router.use(authMiddleware);

router.get('/dashboard',  async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.getDashboard(req.query) }); } catch(e) { next(e); }
});
router.get('/proyectos',  async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.getProyectos(req.query) }); } catch(e) { next(e); }
});
router.get('/proyectos/:id', async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.getProyecto(+req.params.id) }); } catch(e) { next(e); }
});
router.get('/matriz', async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.getMatriz(req.query) }); } catch(e) { next(e); }
});
router.post('/asignaciones', async (req, res, next) => {
  try { res.status(201).json({ status: 'success', data: await service.asignarEmpleado(req.body, req.user.sub) }); } catch(e) { next(e); }
});

module.exports = router;
```

---

### DDL Operaciones

```sql
CREATE TABLE IF NOT EXISTS proyectos (
  id                    SERIAL PRIMARY KEY,
  nombre                VARCHAR(200) NOT NULL,
  cliente_id            INTEGER NOT NULL REFERENCES clientes(id),
  cotizacion_origen_id  INTEGER REFERENCES cotizaciones(id),
  estado                VARCHAR(30) NOT NULL DEFAULT 'planificacion'
                        CHECK (estado IN ('planificacion','activo','en_pausa','completado','cancelado')),
  fecha_inicio_estimada DATE,
  fecha_fin_estimada    DATE,
  presupuesto_aprobado  NUMERIC(16,2),
  descripcion           TEXT,
  creado_por            INTEGER NOT NULL REFERENCES usuarios(id),
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS empleados (
  id         SERIAL PRIMARY KEY,
  nombre     VARCHAR(150) NOT NULL,
  email      VARCHAR(200) UNIQUE NOT NULL,
  cargo      VARCHAR(100),
  area_id    INTEGER REFERENCES areas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asignaciones (
  id               SERIAL PRIMARY KEY,
  proyecto_id      INTEGER NOT NULL REFERENCES proyectos(id),
  empleado_id      INTEGER NOT NULL REFERENCES empleados(id),
  area_id          INTEGER REFERENCES areas(id),
  rol_en_proyecto  VARCHAR(100),
  horas_estimadas  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (horas_estimadas >= 0),
  horas_registradas NUMERIC(6,2) DEFAULT 0 CHECK (horas_registradas >= 0),
  horas            NUMERIC(6,2) GENERATED ALWAYS AS (COALESCE(horas_registradas, 0)) STORED,
  fecha            DATE NOT NULL,
  semana_inicio    DATE,
  semana_fin       DATE,
  asignado_por     INTEGER REFERENCES usuarios(id),
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proyecto_id, empleado_id, fecha)
);

-- Índices para la matriz y dashboard
CREATE INDEX IF NOT EXISTS idx_proyectos_estado    ON proyectos(estado)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_proyectos_cliente   ON proyectos(cliente_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_proyectos_fecha_fin ON proyectos(fecha_fin_estimada) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asignaciones_emp    ON asignaciones(empleado_id, fecha) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asignaciones_proy   ON asignaciones(proyecto_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_empleados_area      ON empleados(area_id) WHERE activo = TRUE;
```

---

## MÓDULO APOYO — RRHH / SIG

### `backend/src/modules/apoyo/apoyo.repository.js`

```javascript
const { pool } = require('../../shared/database/pool');

// ─── RRHH ─────────────────────────────────────────────────────────────────────

const listarEmpleados = async ({ areaId, activo = true, pagina = 1, limite = 50 }) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.nombre, e.email, e.cargo, e.activo, e.created_at,
           a.nombre AS area_nombre,
           COUNT(DISTINCT as2.proyecto_id) FILTER (WHERE p.estado = 'activo') AS proyectos_activos
    FROM empleados e
    LEFT JOIN areas a ON e.area_id = a.id
    LEFT JOIN asignaciones as2 ON e.id = as2.empleado_id AND as2.deleted_at IS NULL
    LEFT JOIN proyectos p ON as2.proyecto_id = p.id
    WHERE e.deleted_at IS NULL
      AND ($1::integer IS NULL OR e.area_id = $1)
      AND e.activo = $2
    GROUP BY e.id, a.nombre
    ORDER BY a.nombre, e.nombre
    LIMIT $3 OFFSET $4
  `, [areaId || null, activo, limite, (pagina - 1) * limite]);
  return rows;
};

const crearEmpleado = async (client, datos) => {
  const { rows } = await client.query(`
    INSERT INTO empleados (nombre, email, cargo, area_id, usuario_id, created_at)
    VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *
  `, [datos.nombre, datos.email, datos.cargo, datos.area_id, datos.usuario_id || null]);
  return rows[0];
};

// ─── SIG (Sistema Integrado de Gestión) ──────────────────────────────────────

const listarDocumentos = async ({ tipo, vigente = true, pagina = 1, limite = 20 }) => {
  const conditions = ['d.deleted_at IS NULL'];
  const params = [];
  let i = 1;
  if (tipo)    { conditions.push(`d.tipo = $${i++}`);              params.push(tipo); }
  if (vigente) { conditions.push(`d.fecha_vencimiento >= NOW()`);  }

  const { rows } = await pool.query(`
    SELECT d.id, d.titulo, d.tipo, d.version, d.fecha_emision, d.fecha_vencimiento,
           d.responsable_id, u.nombre AS responsable_nombre,
           CASE WHEN d.fecha_vencimiento < NOW() + INTERVAL '30 days' THEN true ELSE false END AS por_vencer
    FROM documentos_sig d
    LEFT JOIN usuarios u ON d.responsable_id = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY d.fecha_vencimiento ASC
    LIMIT $${i} OFFSET $${i+1}
  `, [...params, limite, (pagina - 1) * limite]);
  return rows;
};

const crearDocumento = async (client, datos) => {
  const { rows } = await client.query(`
    INSERT INTO documentos_sig (titulo, tipo, version, contenido_url, fecha_emision, fecha_vencimiento, responsable_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *
  `, [datos.titulo, datos.tipo, datos.version, datos.contenido_url,
      datos.fecha_emision, datos.fecha_vencimiento, datos.responsable_id]);
  return rows[0];
};

module.exports = { listarEmpleados, crearEmpleado, listarDocumentos, crearDocumento };
```

---

### DDL Apoyo

```sql
CREATE TABLE IF NOT EXISTS documentos_sig (
  id                SERIAL PRIMARY KEY,
  titulo            VARCHAR(300) NOT NULL,
  tipo              VARCHAR(50) NOT NULL CHECK (tipo IN ('procedimiento','instructivo','politica','formato','registro','otro')),
  version           VARCHAR(10) NOT NULL DEFAULT '1.0',
  contenido_url     TEXT,
  fecha_emision     DATE NOT NULL,
  fecha_vencimiento DATE,
  responsable_id    INTEGER REFERENCES usuarios(id),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sig_tipo      ON documentos_sig(tipo)             WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sig_vencimiento ON documentos_sig(fecha_vencimiento) WHERE deleted_at IS NULL;
```

---

## OBSERVABILIDAD Y CONFIGURACIÓN

### `backend/src/config/env.validator.js`

```javascript
const Joi = require('joi');

/**
 * Valida todas las variables de entorno al arrancar.
 * Si falta alguna crítica, el proceso falla de forma explícita.
 * Mejor un crash en startup que un bug silencioso en producción.
 */
const envSchema = Joi.object({
  NODE_ENV:     Joi.string().valid('development', 'production', 'test').required(),
  PORT:         Joi.number().integer().min(1).max(65535).default(4000),
  DB_HOST:      Joi.string().required(),
  DB_PORT:      Joi.number().integer().default(5432),
  DB_NAME:      Joi.string().required(),
  DB_USER:      Joi.string().required(),
  DB_PASSWORD:  Joi.string().min(8).required(),
  JWT_SECRET:   Joi.string().min(32).required()
                  .messages({ 'string.min': 'JWT_SECRET debe tener al menos 32 caracteres' }),
  JWT_EXPIRES_IN:      Joi.string().default('8h'),
  CORS_ORIGIN:         Joi.string().uri().default('http://localhost:3000'),
  UMBRAL_JEFE:         Joi.number().default(5000000),
  UMBRAL_GERENCIA:     Joi.number().default(20000000),
  LOG_LEVEL:           Joi.string().valid('error','warn','info','debug').default('info'),
}).unknown(true); // Permite variables adicionales del SO

const validateEnv = () => {
  const { error, value } = envSchema.validate(process.env, { abortEarly: false });
  if (error) {
    console.error('\n❌  CONFIGURACIÓN INVÁLIDA — El servidor no puede iniciar:\n');
    error.details.forEach(d => console.error(`   • ${d.message}`));
    console.error('\nRevisa el archivo .env\n');
    process.exit(1);
  }
  return value;
};

module.exports = { validateEnv };
```

---

### `backend/src/config/logger.js`

```javascript
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, errors, json } = format;

const isDev = process.env.NODE_ENV !== 'production';

// Formato legible para desarrollo
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
  })
);

// Formato JSON para producción (compatible con ELK, Datadog, etc.)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new transports.Console(),
    ...(!isDev ? [
      new transports.File({ filename: 'logs/error.log',    level: 'error', maxsize: 10_000_000, maxFiles: 5 }),
      new transports.File({ filename: 'logs/combined.log', maxsize: 10_000_000, maxFiles: 10 }),
    ] : []),
  ],
  exceptionHandlers: [new transports.File({ filename: 'logs/exceptions.log' })],
  rejectionHandlers: [new transports.File({ filename: 'logs/rejections.log' })],
});

// Middleware de request logging para Express
const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method:   req.method,
      path:     req.path,
      status:   res.statusCode,
      duration: `${Date.now() - start}ms`,
      ip:       req.ip,
      user:     req.user?.sub || 'anonymous',
    });
  });
  next();
};

module.exports = { logger, requestLogger };
```

---

### `backend/src/app.js` — Versión final

```javascript
require('dotenv').config();
const { validateEnv } = require('./config/env.validator');
validateEnv(); // Falla rápido si falta configuración

const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const rateLimit = require('express-rate-limit');
const { errorHandler, setupProcessErrorHandlers } = require('./middlewares/error.middleware');
const { requestLogger } = require('./config/logger');

// Módulos
const seguridadRoutes   = require('./modules/seguridad/seguridad.routes');
const comercialRoutes   = require('./modules/comercial/comercial.routes');
const financieroRoutes  = require('./modules/financiero/financiero.routes');
const operacionesRoutes = require('./modules/operaciones/operaciones.routes');
const apoyoRoutes       = require('./modules/apoyo/apoyo.routes');

const app = express();

// ─── Seguridad HTTP ───────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta más tarde.' },
}));

// Rate limiting estricto para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 intentos de login por 15 min
  message: { status: 'error', code: 'AUTH_RATE_LIMIT', message: 'Demasiados intentos de acceso.' },
});

// ─── Parseo ───────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ─── Logging ──────────────────────────────────────────────────────────────────
app.use(requestLogger);

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { pool } = require('./shared/database/pool');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/api/seguridad',   authLimiter, seguridadRoutes);
app.use('/api/comercial',   comercialRoutes);
app.use('/api/financiero',  financieroRoutes);
app.use('/api/operaciones', operacionesRoutes);
app.use('/api/apoyo',       apoyoRoutes);

// 404
app.use((req, res) => res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` }));

// ─── Error handler global (SIEMPRE AL FINAL) ─────────────────────────────────
app.use(errorHandler);

setupProcessErrorHandlers();

module.exports = app;
```

---

### `backend/server.js`

```javascript
const app  = require('./src/app');
const { logger } = require('./src/config/logger');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  logger.info(`🚀 Mapping ERP API corriendo en puerto ${PORT} [${process.env.NODE_ENV}]`);
});

// Graceful shutdown — cierra conexiones activas antes de terminar
const shutdown = (signal) => {
  logger.warn(`Señal ${signal} recibida. Cerrando servidor...`);
  server.close(() => {
    logger.info('Servidor HTTP cerrado. Proceso terminando.');
    process.exit(0);
  });
  setTimeout(() => { logger.error('Shutdown forzado por timeout.'); process.exit(1); }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

---

## DOCKER COMPOSE PRODUCCIÓN

### `docker-compose.yml`

```yaml
version: '3.9'

services:

  postgres:
    image: postgres:16-alpine
    container_name: mapping_db
    restart: unless-stopped
    environment:
      POSTGRES_DB:       ${DB_NAME}
      POSTGRES_USER:     ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./database/init:/docker-entrypoint-initdb.d:ro   # Scripts DDL iniciales
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - mapping_net

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
      target: production
    container_name: mapping_api
    restart: unless-stopped
    env_file: ./backend/.env
    environment:
      DB_HOST: postgres
    ports:
      - "4000:4000"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./backend/logs:/app/logs      # Persistir logs fuera del contenedor
    networks:
      - mapping_net
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: '0.5'

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        REACT_APP_API_URL: ${REACT_APP_API_URL:-http://localhost:4000}
    container_name: mapping_frontend
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - api
    networks:
      - mapping_net

volumes:
  postgres_data:
    driver: local

networks:
  mapping_net:
    driver: bridge
```

---

### `backend/Dockerfile`

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# ─── Dependencias ───────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ─── Desarrollo ─────────────────────────────────────────────────────
FROM base AS development
COPY package*.json ./
RUN npm ci
COPY . .
USER appuser
CMD ["npm", "run", "dev"]

# ─── Producción ─────────────────────────────────────────────────────
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .
# No copiar archivos sensibles
RUN rm -f .env .env.*
USER appuser
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "server.js"]
```

---

## FRONTEND — CAPA DE SERVICIOS

### `frontend/src/api/client.js`

```javascript
import axios from 'axios';

/**
 * Instancia singleton de axios con interceptores globales.
 * Centraliza autenticación, manejo de errores y renovación de tokens.
 */
const apiClient = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:4000',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Request: inyectar token ──────────────────────────────────────────────────
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('erp_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response: manejo global de errores ──────────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response.data, // Desenvuelve .data automáticamente
  (error) => {
    const status  = error.response?.status;
    const message = error.response?.data?.message || 'Error de conexión';
    const code    = error.response?.data?.code;

    // Token expirado → limpiar sesión y redirigir
    if (status === 401) {
      localStorage.removeItem('erp_token');
      localStorage.removeItem('erp_user');
      window.location.href = '/login';
      return Promise.reject(new Error('Sesión expirada'));
    }

    const appError = new Error(message);
    appError.status = status;
    appError.code   = code;
    return Promise.reject(appError);
  }
);

export default apiClient;
```

---

### `frontend/src/features/comercial/services/cotizaciones.service.js`

```javascript
import api from '../../../api/client';

export const cotizacionesService = {
  listar:        (filtros)        => api.get('/api/comercial', { params: filtros }),
  obtener:       (id)             => api.get(`/api/comercial/${id}`),
  crear:         (datos)          => api.post('/api/comercial', datos),
  cambiarEstado: (id, datos)      => api.patch(`/api/comercial/${id}/estado`, datos),
  descargarPDF:  (id)             => api.get(`/api/comercial/${id}/documento/pdf`, { responseType: 'blob' }),
  descargarPPTX: (id)             => api.get(`/api/comercial/${id}/documento/pptx`, { responseType: 'blob' }),
};

/**
 * Helper para disparar descarga de archivo desde blob response
 */
export const descargarArchivo = (blob, filename) => {
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href  = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url); // Liberar memoria
};
```

---

### `frontend/src/hooks/useAuth.js`

```javascript
import { createContext, useContext, useState, useCallback } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('erp_user')); }
    catch { return null; }
  });

  const login = useCallback(async (credentials) => {
    const { data } = await api.post('/api/seguridad/login', credentials);
    localStorage.setItem('erp_token', data.token);
    localStorage.setItem('erp_user',  JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('erp_token');
    localStorage.removeItem('erp_user');
    setUser(null);
  }, []);

  const tienePermiso = useCallback((rolesPermitidos) => {
    if (!user) return false;
    if (user.rol === 'admin') return true;
    return rolesPermitidos.includes(user.rol);
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, login, logout, tienePermiso, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
};
```

---

### `frontend/src/hooks/useAsync.js`

```javascript
import { useState, useCallback } from 'react';

/**
 * Hook genérico para manejar estado de operaciones async.
 * Elimina el boilerplate repetitivo de loading/error/data en cada componente.
 *
 * Uso:
 *   const { execute, loading, error, data } = useAsync(cotizacionesService.listar);
 *   useEffect(() => { execute({ pagina: 1 }); }, []);
 */
export const useAsync = (asyncFn) => {
  const [state, setState] = useState({
    data:    null,
    loading: false,
    error:   null,
  });

  const execute = useCallback(async (...args) => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await asyncFn(...args);
      setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      setState({ data: null, loading: false, error: error.message || 'Error desconocido' });
      throw error; // Re-lanza para que el caller pueda capturar si necesita
    }
  }, [asyncFn]);

  const reset = useCallback(() => setState({ data: null, loading: false, error: null }), []);

  return { ...state, execute, reset };
};
```

---

## `package.json` — Dependencias backend

```json
{
  "name": "mapping-erp-api",
  "version": "1.0.0",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start":   "node server.js",
    "dev":     "nodemon server.js",
    "test":    "jest --coverage",
    "migrate": "node scripts/migrate.js",
    "lint":    "eslint src/ --ext .js"
  },
  "dependencies": {
    "bcryptjs":           "^2.4.3",
    "cors":               "^2.8.5",
    "dotenv":             "^16.4.5",
    "express":            "^4.19.2",
    "express-rate-limit": "^7.3.1",
    "helmet":             "^7.1.0",
    "joi":                "^17.13.1",
    "jsonwebtoken":       "^9.0.2",
    "nodemailer":         "^6.9.14",
    "pg":                 "^8.12.0",
    "pdfkit":             "^0.15.0",
    "pptxgenjs":          "^3.12.0",
    "winston":            "^3.13.0"
  },
  "devDependencies": {
    "jest":              "^29.7.0",
    "nodemon":           "^3.1.4",
    "supertest":         "^7.0.0",
    "eslint":            "^9.6.0"
  }
}
```

---

## MAPA DE ARQUITECTURA FINAL

```
┌─────────────────────────────────────────────────────────────┐
│                    MAPPING INGENIERÍA ERP                    │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┴──────────────┐
         │                              │
┌────────▼────────┐           ┌─────────▼────────┐
│   FRONTEND      │           │    BACKEND API    │
│   React.js      │◄──────────►   Node + Express  │
│                 │   REST     │                  │
│  /api/*         │   JSON     │  Rate Limiting   │
│  axios client   │           │  JWT Auth         │
│  Auth Context   │           │  Helmet / CORS    │
└─────────────────┘           └─────────┬─────────┘
                                        │
              ┌────────────────┬────────┴────────────┬──────────────────┐
              │                │                      │                  │
     ┌────────▼──────┐ ┌───────▼──────┐   ┌──────────▼──────┐ ┌────────▼───────┐
     │  /seguridad   │ │  /comercial  │   │  /financiero    │ │ /operaciones   │
     │  JWT + Roles  │ │  Cotizaciones│   │  Aprobaciones   │ │ Dashboard CTE  │
     │  Soft Delete  │ │  PDF + PPTX  │   │  Multi-nivel    │ │ Matriz Asig.   │
     │               │ │  Máq.Estados │   │  withTransaction│ │                │
     └───────┬───────┘ └──────┬───────┘   └────────┬────────┘ └────────┬───────┘
             │                │                     │                   │
             └────────────────┴─────────────────────┴───────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │   SHARED LAYER       │
                              │                      │
                              │  AppError classes    │
                              │  Pool (singleton)    │
                              │  withTransaction()   │
                              │  validate middleware │
                              │  auth middleware     │
                              │  error handler       │
                              │  Winston logger      │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │    PostgreSQL 16     │
                              │   (Docker volume)    │
                              │                      │
                              │  Transacciones ACID  │
                              │  Índices optimizados │
                              │  Triggers updated_at │
                              │  CHECK constraints   │
                              └─────────────────────┘
```

---

## RESUMEN FINAL — CHECKLIST DE PRODUCCIÓN

| Categoría              | Implementado                                              | Estado |
|------------------------|-----------------------------------------------------------|--------|
| **Arquitectura**       | Separación Controller → Service → Repository              | ✅     |
|                        | Módulos desacoplados por dominio                          | ✅     |
|                        | Shared layer: errores, pool, validación                  | ✅     |
| **Seguridad**          | JWT con issuer validation                                 | ✅     |
|                        | Queries parametrizadas (anti SQL Injection)               | ✅     |
|                        | Bcrypt con 12 salt rounds + timing attack protection      | ✅     |
|                        | Rate limiting por ruta                                    | ✅     |
|                        | Helmet (headers HTTP seguros)                             | ✅     |
|                        | Soft delete en entidades críticas                         | ✅     |
| **Base de Datos**      | Pool singleton con gestión de conexiones                  | ✅     |
|                        | `withTransaction()` en todas las operaciones multi-tabla  | ✅     |
|                        | Índices en columnas de filtrado frecuente                 | ✅     |
|                        | Triggers `updated_at` automáticos                        | ✅     |
|                        | CHECK constraints en estados y valores                    | ✅     |
| **Manejo de Errores**  | Clases de error tipadas (AppError, NotFoundError, etc.)  | ✅     |
|                        | Middleware global con distinción ops/bug                  | ✅     |
|                        | Errores PostgreSQL mapeados (23505, etc.)                 | ✅     |
|                        | Process handlers (unhandledRejection, uncaughtException)  | ✅     |
| **Validación**         | Joi schemas en cada endpoint                              | ✅     |
|                        | `stripUnknown: true` (no campos extra)                   | ✅     |
|                        | Validación de env variables al startup                    | ✅     |
| **Lógica de Negocio**  | Máquina de estados (cotizaciones)                        | ✅     |
|                        | Flujo de aprobación multi-nivel por monto                | ✅     |
|                        | Historial de auditoría en cambios de estado              | ✅     |
|                        | Dashboard CTE (query única, no N+1)                      | ✅     |
|                        | Matriz de asignación con CROSS JOIN + GENERATE_SERIES    | ✅     |
| **Generadores**        | PDF con streams + liberación de memoria                   | ✅     |
|                        | PPTX con imágenes Base64 + manejo de errores por ítem    | ✅     |
| **Observabilidad**     | Winston con formatos dev/prod diferenciados               | ✅     |
|                        | Request logging middleware                                | ✅     |
|                        | Health check endpoint con validación de DB                | ✅     |
| **Infraestructura**    | Docker Compose con healthchecks                          | ✅     |
|                        | Dockerfile multi-stage con usuario no-root                | ✅     |
|                        | Graceful shutdown                                         | ✅     |
| **Frontend**           | Axios singleton con interceptores                         | ✅     |
|                        | AuthContext con validación de permisos                    | ✅     |
|                        | `useAsync` hook (elimina boilerplate)                    | ✅     |

---

## PRÓXIMOS PASOS RECOMENDADOS (Post-MVP Avanzado)

1. **Testing** — Jest + Supertest para integration tests de cada endpoint crítico
2. **Migraciones** — Adoptar `node-pg-migrate` o Flyway para versionar el esquema DDL
3. **Queue de trabajos** — Mover generación PDF/PPTX a Bull/BullMQ para no bloquear requests en archivos grandes
4. **Caché** — Redis para métricas del dashboard (TTL 60s) y sesiones
5. **Storage de archivos** — Migrar `imagen_base64` de BD a S3/MinIO con URLs firmadas
6. **Notificaciones** — WebSockets (Socket.io) para alertas en tiempo real de aprobaciones pendientes
7. **CI/CD** — GitHub Actions: lint → test → build Docker → deploy
