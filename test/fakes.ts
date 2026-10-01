export type Opts = Record<string, string | number | boolean | { id: string; joinable?: boolean; speakable?: boolean } | undefined>;

/** Just enough of a ChatInputCommandInteraction for the handlers. */
export function fakeInteraction(commandName: string, opts: Opts = {}, subcommand?: string) {
  const out: { content?: string; embeds?: { data: { title?: string; description?: string; fields?: { name: string; value: string }[] } }[] }[] = [];
  const get = (name: string, required?: boolean) => {
    const v = opts[name];
    if (v === undefined && required) throw new Error(`missing required option ${name}`);
    return v ?? null;
  };
  const record = async (payload: string | { content?: string; embeds?: never[] }) => {
    out.push(typeof payload === 'string' ? { content: payload } : payload);
  };
  const i = {
    commandName,
    guildId: 'g1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    isRepliable: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: get,
      getInteger: get,
      getNumber: get,
      getBoolean: get,
      getChannel: get,
    },
    reply: async (p: string | { content?: string }) => {
      i.replied = true;
      await record(p);
    },
    deferReply: async () => {
      i.deferred = true;
    },
    editReply: record,
    out,
    text: () => out.map((o) => [o.content, ...(o.embeds ?? []).map((e) => JSON.stringify(e.data))].join(' ')).join('\n'),
  };
  return i;
}
