// Assuming fallbackWorkspace is defined elsewhere, e.g.:
import { fallbackWorkspace } from "../config.js";

/**
 * Generates a clever "thinking" statement related to coding,
 * optionally incorporating the workspace slug.
 *
 * @param {string} [finalWorkspaceSlug] - The unique identifier for the workspace. Optional.
 * @returns {string} A creative message indicating that the system is processing.
 */
const getWorkplaceThinkingString = (finalWorkspaceSlug) => {
  const baseStatements = [
    "🧠 Compiling cognitive functions",
    "⚡ Synthesizing logic in the circuits",
    "🔁 Iterating through possibilities",
    "🏗️ Refactoring thoughts within the architecture",
    "🚀 Optimizing mental algorithms",
    "🔍 Parsing the syntax",
    "💻 Executing thought processes",
    "🐛 Debugging the cognitive flow",
    "🧱 Building mental constructs",
    "🎛️ Orchestrating the microservices of intellect",
    "☕ Brewing a fresh batch of insights",
    "👻 Summoning the code spirits",
    "🗣️ Engaging the mental interpreters",
    "💡 Firing up the intellectual IDE",
    "✨ Letting the mental compiler work its magic",
    "🤔 Formulating elegant solutions",
    "➿ Recursively exploring options",
    "🛠️ Constructing robust systems",
    "⚙️ Fine-tuning the engine of thought",
    "📚 Consulting the ancient code libraries",
    "📡 Probing the depths of cyberspace",
    "📡 Initiating data stream analysis",
    "🧮 Processing quantum entanglement",
    "🧬 Engineering code evolution",
    "🗝️ Unlocking hidden potential",
    "📜 Deciphering cryptic algorithms",
    "🔮 Envisioning the future of code",
    "🧭 Navigating the digital frontier",
    "🌌 Contemplating the universe of information",
    "🌠 Weaving intricate tapestries of logic",
    "💡 Illuminating the neural pathways",
    "⚛️ Deconstructing the fundamental particles of thought",
    "🔬 Analyzing the microscopic structures of cognition",
    "🧩 Assembling the puzzle of understanding",
    "🎨 Painting masterpieces of ingenuity",
    "🎻 Composing symphonies of code",
    "🎭 Performing dramatic enactments of logic",
    "🧘‍♂️ Meditating on the zen of programming",
    "🏹 Targeting the bullseye of precision",
    "🌟 Channeling the cosmic energy of creation",
    "💾 Caching frequently accessed thoughts",
    "🔗 Establishing connections between concepts",
    "📊 Visualizing the data flow",
    "📈 Plotting the trajectory of the solution",
    "🌍 Mapping the knowledge domain",
    "⏳ Synchronizing internal clocks",
    "💡 Sparking innovative connections",
    "🧬 Simulating evolutionary algorithms",
    "🤖 Assembling the logical core",
    "🕸️ Spinning a web of interconnected ideas",
    "🗝️ Decrypting the problem's enigma",
    "🚀 Launching exploratory thought probes",
    "🌀 Navigating the vortex of complexity",
    "💎 Polishing the facets of the solution",
    "🛠️ Forging new pathways in the code",
    "✨ Conjuring elegant abstractions",
    "🧩 Integrating disparate components",
    "🧠 Engaging the pattern recognition engine",
    "⚡ Supercharging the processing units",
    "🌌 Exploring the solution space",
  ];

  const addWorkspaceSuffix = finalWorkspaceSlug && finalWorkspaceSlug !== fallbackWorkspace;

  const randomIndex = Math.floor(Math.random() * baseStatements.length);
  let chosenStatement = baseStatements[randomIndex];

  if (addWorkspaceSuffix) {
    const firstSpaceIndex = chosenStatement.indexOf(" ");
    const icon = chosenStatement.substring(0, firstSpaceIndex);
    const text = chosenStatement.substring(firstSpaceIndex + 1);
    chosenStatement = `${icon} ${text} in \`${finalWorkspaceSlug}\``;
  }

  return `${chosenStatement}...`;
};

/**
 * A service that provides coding-related thinking statements.
 */
const strings = {
  getWorkplaceThinkingString,
};

export default strings;
