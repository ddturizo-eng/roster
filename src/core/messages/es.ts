// Spanish templates (`human_language: es`).

import type { Catalog } from './catalog.ts';

const list = (items: readonly string[]): string => items.join(', ');

export const ES: Catalog = {
  'stop.invalidResult': ({ contract, problems }) =>
    `El resultado ${contract} falta o no es válido: ${list(problems)}.`,
  'stop.noChanges': () => 'El agente terminó sin cambiar ningún archivo.',
  'stop.protectedPath': ({ paths, branch, workspace }) =>
    `Los cambios tocan rutas protegidas o no permitidas: ${list(paths)}. ` +
    `El commit queda en la rama local ${branch} en ${workspace}. No se subió nada; solo el humano puede subirla.`,
  'stop.dependencyApproval': ({ manifests, hash, task }) =>
    `Cambiaron manifiestos de dependencias: ${list(manifests)} (hash ${hash}). No se subió nada. ` +
    `Revisa el cambio y apruébalo con: roster retry ${task} --approve-dependencies`,
  'stop.verificationFailed': ({ command, exitCode, branch, tail }) =>
    `La verificación falló: ${command} terminó con código ${exitCode === null ? 'ninguno' : exitCode}. ` +
    `La rama ${branch} se sube sin PR.` +
    (tail === '' ? '' : `\nÚltimas líneas:\n${tail}`),
  'stop.timeout': ({ job, minutes }) => `El trabajo ${job} alcanzó su límite de tiempo de ${minutes} minutos.`,
  'stop.error': ({ job, reason }) => `El trabajo ${job} falló: ${reason}.`,
  'stop.interrupted': () =>
    'La ejecución se interrumpió: el proceso de roster run terminó antes de que acabara.',
  'stop.stopped': () =>
    'Detenida por el humano con roster stop. No se subió nada; el espacio de trabajo se conserva.',
  'stop.dockerUnavailable': ({ reason }) =>
    `Docker no responde: ${reason}. Inicia Docker Desktop y compruébalo con roster doctor.`,
  'stop.quotaCooldown': ({ runtime, branch, until, window }) =>
    `Se agotó la cuota de ${runtime}. El trabajo en curso se subió a ${branch} y la tarea vuelve a todo. ` +
    (window === null
      ? `No habrá ejecuciones con ${runtime} hasta ${until} (estimado).`
      : `No habrá ejecuciones con ${runtime} hasta ${until}, cuando se reinicia la ventana ${window}.`),
  'stop.hirePrOpened': ({ agent, prUrl }) =>
    `Esperando el PR de contratación del agente ${agent}: ${prUrl}. Fusiónalo para continuar la tarea.`,
  'stop.prClosedUnmerged': ({ prUrl, task }) =>
    `El PR ${prUrl} se cerró sin fusionar; la tarea queda rechazada. Para reintentarla: roster retry ${task}`,

  'run.busy': ({ pid }) => `Otro proceso de roster (PID ${pid}) tiene el bloqueo. Saliendo.`,
  'run.recoveredInterrupted': ({ executionId }) =>
    `La ejecución ${executionId} quedó en curso tras terminar su proceso; marcada como interrumpida.`,
  'run.nightLimitReached': ({ started, max }) =>
    `Ya empezaron ${started} de ${max} ejecuciones en esta ventana nocturna. Saliendo.`,
  'run.dockerUnavailable': ({ reason }) => `Docker no responde: ${reason}. Saliendo con código 2.`,
  'run.syncing': () => 'Sincronizando el repo de Roster, los proyectos y los pull requests...',
  'run.syncDone': ({ projects, pullRequests }) =>
    `Sincronización lista: ${projects} proyectos, ${pullRequests} pull requests revisados.`,
  'run.nothingToDo': () => 'No hay nada que hacer.',
  'run.selectedTask': ({ task, title }) => `Tarea seleccionada ${task}: ${title}`,
  'run.selectedStageJob': ({ feature, job }) => `Seleccionado el trabajo ${job} de la feature ${feature}.`,
  'run.hiring': ({ task }) => `La tarea ${task} no tiene agente aprobado; empieza el paso de contratación.`,
  'run.agentReused': ({ agent, task }) => `Se reutiliza el agente aprobado ${agent} para la tarea ${task}.`,
  'run.noRuntime': ({ agent }) =>
    `No hay runtime disponible para el agente ${agent} (no habilitado, sin las capacidades o en espera por cuota). Saliendo.`,
  'run.runtimeCooldown': ({ runtime, until }) => `El runtime ${runtime} está en espera por cuota hasta ${until}.`,
  'run.executionStarted': ({ executionId, task, agent, runtime }) =>
    `Ejecución ${executionId} iniciada: tarea ${task}, agente ${agent}, runtime ${runtime}.`,
  'run.resuming': ({ branch }) => `Se retoma desde la rama existente ${branch}.`,
  'run.stepStarted': ({ step }) => `Paso: ${step}`,
  'run.prOpened': ({ prUrl }) => `PR abierto: ${prUrl}`,
  'run.executionFinished': ({ executionId, status }) => `Ejecución ${executionId} terminada: ${status}.`,
  'run.stopReason': ({ reason }) => `Motivo: ${reason}`,
  'run.dryRun': () => 'Simulación: no se escribe nada salvo la caché de sincronización.',
  'run.dryRunPlan': ({ steps }) => `Pasos previstos: ${list(steps)}.`,
};
