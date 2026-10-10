// Fun facts and tips. Herdy shares one every few pokes, and the About box (press ?) has a button for more.
// Add yours: one sentence, true, under 140 characters, no links. test/trivia.test.js keeps us honest.
export const TRIVIA = [
  // sheep and herding (Herdy's department)
  'Sheep can recognise at least 50 individual sheep faces and remember them for over two years.',
  'A sheep\'s rectangular pupils give it a field of view of roughly 270 degrees or more.',
  'Dolly the sheep, the first mammal cloned from an adult cell, was born in 1996 at the Roslin Institute.',
  'Chaser, a border collie, learned the names of more than 1,000 objects.',
  'In Iceland, sheep roam the highlands all summer and are rounded up together in September.',
  'A group of sheep is a flock. A group of herdr panes is a workspace.',
  // terminals and unix
  'The Esc key is ASCII 27, and almost every terminal colour code starts with it.',
  'The terminal bell is ASCII 7. That is the beep your first shell script made.',
  'The DEC VT100 (1978) popularised the escape codes your terminal still understands.',
  'GNU Screen came out in 1987 and tmux in 2007. Terminal multiplexers are older than most frameworks.',
  'Unix pipes arrived in 1973, reportedly implemented by Ken Thompson in a single night.',
  '"Hello, World" first appeared in a 1972 tutorial for the B language.',
  'Linus Torvalds started git in April 2005 to manage the Linux kernel.',
  'The first computer "bug" was a moth taped into the Harvard Mark II log in 1947.',
  'Ctrl+C sends SIGINT, a polite request to stop. Esc is how most coding agents take the hint.',
  // games, pixels and the web
  'Atari released Pong in 1972. Yes, there is a ping-pong table in the lounge for a reason.',
  'The pixel font in the header, Press Start 2P, is modelled on 1980s Namco arcade games.',
  'A* pathfinding dates from 1968, from the team behind the Shakey robot. The workers use it to find the pantry.',
  'The first webcam pointed at a coffee pot, in a Cambridge computer lab in 1991. Offices have watched coffee ever since.',
  'Server-Sent Events are plain HTTP, and the browser reconnects by itself. This page uses them for everything live.',
  'Pixel-art tiles are traditionally 8, 16 or 32 pixels square. This office uses 16.',
  // this project
  'Each worker\'s face comes from a hash of its pane id, so the same pane always gets the same colleague.',
  'No database here: the whole office is redrawn from herdr\'s snapshot about once a second.',
  'Idle workers go back to their desks and sleep between 21:00 and 06:00, by your clock.',
  'When an agent launches sub-agents, an intern walks in from the pantry for each one.',
  'Herdy trots over to the desk of any agent that is waiting for you.',
  'Uploaded images are saved owner-only on the host and deleted after 24 hours.',
  'The chat view is rebuilt from each agent\'s own session log, because herdr only sees the terminal screen.',
  // tips
  'Tip: press [ and ] to flip between floors.',
  'Tip: a link like #w2:p6 opens that agent straight away. Bookmark your favourite desk.',
  'Tip: Follow mode moves the office to whichever workspace you focus in herdr.',
  'Tip: paste or drag a screenshot into the chat box to send it to the agent.',
  'Tip: the Stop button in the chat is Esc (Ctrl+C for Cursor) without finding the terminal tab.',
  'Tip: press ? for shortcuts and to see how many secrets you have found.',
];

export const triviaAt = (i) => TRIVIA[((i % TRIVIA.length) + TRIVIA.length) % TRIVIA.length];
export const randomTrivia = (not = -1) => {
  let i = Math.floor(Math.random() * TRIVIA.length);
  if (i === not) i = (i + 1) % TRIVIA.length;
  return i;
};
