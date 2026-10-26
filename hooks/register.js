const LINEAR_API_BASE_URL = 'https://api.linear.app/graphql'

async function queryLinearGql($, headers, method, data) {
  const response = await $.http.fetch(LINEAR_API_BASE_URL, {
    method: method,
    headers: headers,
    body: JSON.stringify(data)
  })
  await $.ui.log(`Response: ${JSON.stringify(response)}`)
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "link-linear",
      description: "Link Linear issue",
    });
    return next(e);
  });

  on("command.run", { command: "link-linear" }, async ($) => {
    await $.ui.open({
      id: "linear-issue-linking-pane",
      title: "Link Linear Issue",
      focus: true,
      closeOnEscape: true,
    });
    return {};
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== "linear-issue-linking-pane") return next(e);

    const { Box, Text, Button, Input } = $.ui.resolve(e);

    const redraw = () => $.ui.invalidate("ui.render");

    return Box({
      children: [
        Text({ children: ["Link the Linear Issue that you want to work on"] }),
        Input({
          key: "linear-base-url",
          label: "Linear Base URL",
          placeholder: "Enter the Liner Organization Base URL",
          value: "",
          submitLabel: "add",
          autoFocus: true,
          onSubmit: async (value) => {
            if (!value.trim()) return;
            await $.env.set("LINEAR_API_KEY", value.trim())
            await $.ui.log(`Linear Credentials Captured! Use 'Test Connection' to validate the connection`)
          },
        }),
        Button({
          key: 'test-api',
          label: 'Test Connection',
          onPress: async () => {
            const response = await queryLinearGql($, {'content-type': 'application/json'}, 'POST', { "query": "{ issues { nodes { id title } } }" })
            await $.ui.log(response)
          }
        })
      ],
    });
  });
}
