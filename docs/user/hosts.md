# Hosts

The **Hosts** panel shows how each machine you are connected to is doing: processor, memory, swap,
disk, graphics card, temperature, network, running agents and Mesura Code servers. Each machine
keeps the last 12 hours of its own readings, so the panel shows a trend as soon as it opens.

## Open the panel

- Hold `Alt+S`. Release `S` or `Alt` to close the panel.
- Hover over the **Hosts** button (the server icon) in the sidebar footer.
- Select the **Hosts** button to keep the panel open. Select it again or press `Escape` to close
  it.
- Choose **Show hosts** in the command palette to keep the panel open. From Settings, Usage or
  Pull requests it returns to the thread list first, and it opens a hidden sidebar.

The panel opens inside the sidebar, above the footer buttons, in the same place as the
[account limits](./account-limits.md) panel. Only one of the two is open at a time: opening one
closes the other. Like that panel, it is available on the thread list only, and not when the window
is as narrow as a phone.

You can change the shortcut in **Settings → Keybindings**, where it is listed as **Hosts: Peek**.

## What each machine shows

The first line counts the machines that are connected, and the agents running on the machines whose
readings are current.

Each machine then has a header with its name, a **local** tag for the machine this app is attached
to, and how long it has been up. Below the header:

- **CPU**: how busy the processor is, with the load average beside it.
- **RAM** and **Swap**: the memory in use, out of the total.
- **Disk**: how full the disk that holds Mesura Code's data and worktrees is, with the free space
  beside it.
- **GPU**: how busy the graphics card is, with its memory use beside it. A laptop graphics card
  that is powered down shows **asleep**; Mesura Code does not wake it to read it.
- **Temp**: the processor temperature.
- **Net**: the data received and sent each second.
- **Agents**: the agents working right now, out of the agent sessions that are open.
- A last line counts the Mesura Code servers on the machine, and how many are development servers.

The small charts cover the last 12 hours. Hover over a chart to read the time and the value at that
point. A break in a line is a time when the machine did not take readings, for example because it
was asleep or switched off.

Numbers stay neutral while they are normal. They turn amber when a machine is under pressure and
red when it is close to its limit.

## When a number cannot be trusted

- **Stale**: the machine is still connected but stopped sending readings. Its numbers stay on
  screen, dimmed, with the age of the last reading.
- **Offline**: Mesura Code cannot reach the machine. Its last numbers stay on screen, dimmed, with
  their age.
- **Update Mesura Code on this host**: the machine runs a version of Mesura Code that does not send
  these readings. Update it to see them.
- **n/a**: the machine cannot measure that value, for example a machine with no swap or no
  temperature sensor.
- **Waiting for the first reading**: the machine is connected and its first readings have not
  arrived yet.
