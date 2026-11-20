// Shapes shared by the interactive reference and mobile code generators.
const integer = { type: "integer" },
  string = { type: "string" },
  number = { type: "number" };
const nullable = (s) => ({ anyOf: [s, { type: "null" }] });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});
const array = (items) => ({ type: "array", items }),
  ref = (name) => ({ $ref: "#/components/schemas/" + name });
const flag = { type: "integer", enum: [0, 1] },
  instant = { type: "string", format: "date-time" };
const user = {
  id: integer,
  name: string,
  email: { type: "string", format: "email" },
  role: { type: "string", enum: ["user", "admin"] },
};
const event = {
  id: integer,
  owner: integer,
  title: string,
  sport: string,
  description: string,
  place: string,
  lat: number,
  lng: number,
  start: instant,
  duration: integer,
  capacity: integer,
  minAge: integer,
  gate: { type: "string", enum: ["qr", "ticket", "open"] },
  status: {
    type: "string",
    enum: ["pending", "approved", "rejected", "removed"],
  },
};
const ticket = {
  id: integer,
  event: integer,
  user: integer,
  attended: flag,
  rank: nullable(integer),
};
const publicEvent = { ...event, organizer: string, booked: integer };
const models = {
  Error: object({ error: string }),
  OK: object({ ok: { type: "boolean" } }),
  Session: object({
    token: string,
    id: integer,
    name: string,
    role: user.role,
  }),
  Event: object(publicEvent),
  Review: object({ stars: integer, body: string, name: string }),
  EventDetails: object({ ...publicEvent, reviews: array(ref("Review")) }),
  Ticket: object({
    ...ticket,
    token: string,
    title: string,
    start: instant,
    sport: string,
    duration: integer,
    status: event.status,
    gate: event.gate,
  }),
  Participant: object({ ...ticket, name: string }),
  Profile: object({
    ...user,
    birth: nullable({ type: "string", format: "date" }),
    created: array(object(event)),
    tickets: array(ref("Ticket")),
    attended: integer,
    held: integer,
    xp: integer,
    level: integer,
    achievements: array(
      object({
        event: integer,
        title: string,
        kind: string,
        rank: nullable(integer),
      }),
    ),
  }),
  Admin: object({
    events: array(ref("Event")),
    users: array(object({ ...user, banned: flag, deleted: flag })),
    logs: array(
      object({
        id: integer,
        at: string,
        actor: nullable(integer),
        action: string,
        ip: string,
        target: string,
      }),
    ),
  }),
};
delete models.Participant.properties.event;
models.Participant.required = models.Participant.required.filter(
  (k) => k !== "event",
);
export function completeContract(spec) {
  spec.components.schemas = models;
  const outputs = {
    "post /register": ref("Session"),
    "post /login": ref("Session"),
    "get /me": ref("Profile"),
    "get /events": array(ref("Event")),
    "get /events/{id}": ref("EventDetails"),
    "post /events": object({ id: integer, status: event.status }),
    "post /events/{id}/join": object({ event: integer }),
    "get /events/{id}/roster": array(ref("Participant")),
    "post /events/{id}/checkin": object({ name: string }),
    "get /admin": ref("Admin"),
  };
  for (const [path, methods] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(methods)) {
      const media = path.endsWith("/qr") ? "image/png" : "application/json";
      op.operationId =
        method +
        path
          .replace(/\/api|[{}]/g, "")
          .replace(/\/(.)/g, (_, c) => c.toUpperCase());
      op.responses[200].content = {
        [media]: {
          schema:
            media === "image/png"
              ? { type: "string", format: "binary" }
              : outputs[method + " " + path.slice(4)] || ref("OK"),
        },
      };
      for (const [code, label] of Object.entries({
        400: "Некорректные поля",
        401: "Требуется вход",
        403: "Доступ ограничен",
        404: "Объект не найден",
        409: "Конфликт состояния",
        429: "Лимит запросов",
      }))
        op.responses[code] = {
          description: label,
          content: { "application/json": { schema: ref("Error") } },
        };
    }
}
