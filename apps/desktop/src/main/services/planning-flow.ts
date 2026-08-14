// PlanningFlow — the composition of AgentService + PlanService that every planning/execution IPC
// handler is made of (dev-planning v2, decision 55): build a task → run it through the agent queue →
// finalize deterministically when it lands. It lives next to the services instead of inline in the
// composition root so the whole flow can be driven end-to-end by a fake engine in tests (no
// Electron, no SDK subprocess) — main/index.ts only maps IPC channels onto these methods.
import type { AgentStreamMessage } from '@alethic/ipc';
import type { AgentService } from './agent.service';
import type { PlanService } from './plan.service';

export class PlanningFlow {
  constructor(
    private readonly agent: AgentService,
    private readonly plan: PlanService,
  ) {
    // A landed phase (or the "update code map" action) grows the Code branch by scanning the code
    // it produced (decision 55). It goes through AgentService, so it queues behind whatever runs now.
    this.plan.onCodeMap((request) => {
      const { taskId } = this.agent.send({
        prompt: request.prompt,
        model: request.model,
        role: 'scanner',
      });
      this.plan.trackCodeMap(taskId, request);
    });
  }

  /** Chat's "Create plan" / "Add to plan": the Planner grows the single plan document. */
  createPlan(message: string, model: string): { taskId: string } {
    const task = this.plan.buildPlanTask(message);
    return this.agent.send({ prompt: task.prompt, model, role: task.role });
  }

  /** Welcome's "Start building" on an empty folder (decision 29) — dev plans, plan mode authors. */
  startBuilding(
    description: string,
    model: string,
    mode: 'dev' | 'plan',
  ): { started: boolean; taskId: string } {
    const task = this.plan.buildGreenfieldTask(description, mode); // ensures the root + writes mode
    const { taskId } = this.agent.send({ prompt: task.prompt, model, role: task.role });
    return { started: true, taskId };
  }

  /** Run one phase of the roadmap; its completion ticks the checkboxes and maps the new code. */
  executePhase(planId: string, phaseIndex: number, model: string): { started: boolean } {
    const prep = this.plan.preparePhase(planId, phaseIndex, model);
    if (!prep) return { started: false };
    const { taskId } = this.agent.send({ prompt: prep.prompt, model, role: 'executor' });
    this.plan.trackPhase(taskId, prep);
    return { started: true };
  }

  /** "Update code map" on the Code branch — a scanner pass over the whole working tree. */
  mapCode(model: string): { started: boolean } {
    return this.plan.requestCodeMap(model);
  }

  /** Per-phase status after the plan view remounts: the active task runs, the rest are queued. */
  phaseStatus(planId: string): { running: number[]; queued: number[] } {
    const active = this.agent.activeTask().taskId;
    const running: number[] = [];
    const queued: number[] = [];
    for (const { taskId, phaseIndex } of this.plan.pendingPhaseEntries(planId))
      (taskId === active ? running : queued).push(phaseIndex);
    return { running, queued };
  }

  /** Fed from the single agent event stream: correlates a completed run with its phase. */
  handleAgentEvent(event: AgentStreamMessage): void {
    this.plan.handleAgentEvent(event);
  }
}
