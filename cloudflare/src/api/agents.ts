// Agents (contract/src/agents.ts), over the Workspace Durable Object, which holds the rules: who may edit
// (`#editable`), which connections may be added (`#chosenConnections`), the full replace, the revocation of
// the agent's runs when its connection set changes, and the last agent kept.

import { api, checkStopped, inWorkspace, refusal, unwrap } from "./procedures.ts";

const agents = api.agents.use(inWorkspace);

export const agentProcedures = agents.router({
	list: agents.list.handler(({ context: { member } }) => member.object.listAgents(member.caller)),

	get: agents.get.handler(async ({ context: { member }, input }) => {
		const agent = await member.object.getAgent(member.caller, input.agentId);
		if (agent === null) throw refusal("NOT_FOUND", "Not found.");
		return agent;
	}),

	create: agents.create.handler(async ({ context: { member }, input: { workspaceId: _, ...agent } }) => unwrap(await member.object.createAgent(member.caller, agent))),

	update: agents.update.handler(async ({ context: { member }, input: { workspaceId: _, agentId, ...fields } }) => {
		const { agent, revocation } = unwrap(await member.object.updateAgent(member.caller, agentId, fields));
		checkStopped(revocation);
		return agent;
	}),

	delete: agents.delete.handler(async ({ context: { member }, input }) => {
		checkStopped(unwrap(await member.object.deleteAgent(member.caller, input.agentId)).revocation);
	}),
});
