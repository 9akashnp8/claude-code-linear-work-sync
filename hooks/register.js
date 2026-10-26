let configuration = {}

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
          key: 'linear-base-url',
          label: 'Linear Base URL',
          placeholder: 'Enter the Liner Organization Base URL',
          value: '',
          submitLabel: 'add',
          autoFocus: true,
          onSubmit: async (value) => {
            if (!value.trim()) return
            configuration = {...configuration, value: value}
            redraw()
            await $.store.set('configuration', configuration)
          }
        })
      ],
    });
  });
}
