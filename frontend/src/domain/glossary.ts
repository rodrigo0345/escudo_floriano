/** Technical terms shown on screen, each with a one-line explanation in plain Portuguese (see `GlossaryTip`). Add a term here and give it a `term` where it is shown. */
export const GLOSSARY = {
  crownFire: {
    title: 'Fogo de copas',
    text: 'O fogo sobe às copas das árvores e passa de uma copa à seguinte. Avança mais depressa, lança faíscas e é muito difícil de travar.',
  },
  crewExposure: {
    title: 'Pessoal em zona de fogo',
    text: 'Pessoas das equipas que passam algum minuto numa zona a arder, a caminho do local ou a trabalhar. É daqui que saem os feridos.',
  },
  casualties: {
    title: 'Feridos',
    text: 'Bombeiros apanhados pelo fogo. Uma equipa perde uma parte dos elementos por cada minuto dentro do fogo. Um plano que preveja feridos não é publicado.',
  },
  forwardReserve: {
    title: 'Reserva avançada',
    text: 'Meios que esperam perto do fogo, num ponto que o fogo previsto não atinge, prontos a entrar em minutos.',
  },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
