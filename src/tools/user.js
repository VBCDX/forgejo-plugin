// whoami — the identity behind the credential file.

import { getJson, inputSchema, success } from '../toolkit.js';
import { envelopeSchema, S } from '../schemas.js';
import { projectUser } from '../projections.js';

export const userTools = [
  {
    name: 'whoami',
    description: 'Return the Forgejo user the supplied credential authenticates as.',
    effect: 'read',
    permissions: ['read:user'],
    method: 'GET',
    route: '/user',
    input: inputSchema({}),
    output: envelopeSchema(S.user),
    async run({ call, auth }) {
      const path = '/user';
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      return success({ method: 'GET', path, status: r.status, data: projectUser(r.json) });
    },
  },
];
