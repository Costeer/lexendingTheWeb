(() => {
  "use strict";

  const quotes = [
    {
      text: "Zu sagen, was ist, bleibt die revolutionärste Tat.",
      author: "Rosa Luxemburg",
      url: "https://en.wikipedia.org/wiki/Rosa_Luxemburg",
      lang: "de"
    },
    {
      text: "Freedom is always and exclusively freedom for the one who thinks differently.",
      author: "Rosa Luxemburg",
      url: "https://en.wikipedia.org/wiki/Rosa_Luxemburg",
      lang: "en"
    },
    {
      text: "The philosophers have only interpreted the world in various ways; the point is to change it.",
      author: "Karl Marx",
      url: "https://en.wikipedia.org/wiki/Karl_Marx",
      lang: "en"
    },
    {
      text: "To be radical is to grasp things by the root.",
      author: "Karl Marx",
      url: "https://en.wikipedia.org/wiki/Karl_Marx",
      lang: "en"
    },
    {
      text: "A revolution is certainly the most authoritarian thing there is.",
      author: "Friedrich Engels",
      url: "https://en.wikipedia.org/wiki/Friedrich_Engels",
      lang: "en"
    },
    {
      text: "The state is not ‘abolished,’ it withers away.",
      author: "Friedrich Engels",
      url: "https://en.wikipedia.org/wiki/Friedrich_Engels",
      lang: "en"
    },
    {
      text: "Without revolutionary theory there can be no revolutionary movement.",
      author: "Vladimir Lenin",
      url: "https://en.wikipedia.org/wiki/Vladimir_Lenin",
      lang: "en"
    },
    {
      text: "Victory will belong only to those who have faith in the people, those who are immersed in the life-giving spring of popular creativity.",
      author: "Vladimir Lenin",
      url: "https://en.wikipedia.org/wiki/Vladimir_Lenin",
      lang: "en"
    },
    {
      text: "Only in conjunction with the proletarian woman will socialism be victorious.",
      author: "Clara Zetkin",
      url: "https://en.wikipedia.org/wiki/Clara_Zetkin",
      lang: "en"
    },
    {
      text: "We must dare to invent the future.",
      author: "Thomas Sankara",
      url: "https://en.wikipedia.org/wiki/Thomas_Sankara",
      lang: "en"
    },
    {
      text: "Our great democracies still tend to think that a stupid man is more likely to be honest than a clever man, and our politicians take advantage of this prejudice by pretending to be even more stupid than nature made them.",
      author: "Bertrand Russell",
      url: "https://en.wikipedia.org/wiki/Bertrand_Russell",
      lang: "en"
    },
    {
      text: "You show me a capitalist, and I'll show you a bloodsucker.",
      author: "Malcolm X",
      url: "https://en.wikipedia.org/wiki/Malcolm_X",
      lang: "en"
    },
    {
      text: "The revolution introduced me to art, and art, in its own turn, brought me to the revolution.",
      author: "Sergei Eisenstein",
      url: "https://en.wikipedia.org/wiki/Sergei_Eisenstein",
      lang: "en"
    },
    {
      text: "The only way we'll get freedom for ourselves is to identify ourselves with every oppressed people in the world. We are blood brothers to the people of Brazil, Venezuela, Haiti, Cuba—yes, Cuba too.",
      author: "Malcolm X",
      url: "https://en.wikipedia.org/wiki/Malcolm_X",
      lang: "en"
    },
    {
      text: "Darwin did not know what a bitter satire he wrote on mankind, and especially on his countrymen, when he showed that free competition, the struggle for existence, which the economists celebrate as the highest historical achievement, is the normal state of the animal kingdom. Only conscious organisation of social production, in which production and distribution are carried on in a planned way, can lift mankind above the rest of the animal world as regards the social aspect, in the same way that production in general has done this for men in their aspect as species.",
      author: "Friedrich Engels",
      url: "https://en.wikipedia.org/wiki/Friedrich_Engels",
      lang: "en"
    },
    {
      text: "I am not a labor leader; I do not want you to follow me or anyone else. If you are looking for a Moses to lead you out of this capitalist wilderness, you will stay right where you are. I would not lead you into the promised land if I could, because if I led you in, someone else would lead you out. You must use your heads as well as your hands and get yourself out of your present condition; as it is now, the capitalists use your heads and your hands.",
      author: "Eugene V. Debs",
      url: "https://en.wikipedia.org/wiki/Eugene_V._Debs",
      lang: "en"
    }
  ].map(Object.freeze);

  const randomIndex = () => Math.floor(Math.random() * quotes.length);

  const random = () => {
    let index = randomIndex();
    try {
      const key = "lexendLastQuoteIndex";
      const previous = Number.parseInt(globalThis.localStorage.getItem(key), 10);
      if (quotes.length > 1 && Number.isInteger(previous) && previous === index) {
        index = (index + 1 + Math.floor(Math.random() * (quotes.length - 1))) % quotes.length;
      }
      globalThis.localStorage.setItem(key, String(index));
    } catch {
      // Random selection still works if local storage is unavailable.
    }
    return quotes[index];
  };

  globalThis.LexendQuotes = Object.freeze({
    all: Object.freeze(quotes),
    random
  });
})();
