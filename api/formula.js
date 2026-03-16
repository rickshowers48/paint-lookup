const FORMULA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTsjyEtVcJe-HHdqbK4AGzjOm6fZNsqEx6Be_7P99vgzWXCWPSIlaUa9zCoH8UxqiF7emmGxEwy-iL_/pub?gid=1255336829&single=true&output=csv";

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {

    const { paintCode, batchSize = 15 } = req.body;

    if (!paintCode) {
      return res.status(400).json({ ok: false, error: "paintCode required" });
    }

    const response = await fetch(FORMULA_CSV_URL);
    const csv = await response.text();

    const rows = csv.split("\n").slice(1);

    const formula = [];

    rows.forEach((row) => {

      const cols = row.split(",");

      const code = cols[0]?.trim();
      const component = cols[1]?.trim();
      const grams = parseFloat(cols[2]);

      if (code === paintCode) {

        const multiplier = batchSize / 10;

        formula.push({
          component,
          grams: Number((grams * multiplier).toFixed(2))
        });

      }

    });

    return res.status(200).json({
      ok: true,
      paintCode,
      batchSize,
      formula
    });

  } catch (err) {

    return res.status(500).json({
      ok: false,
      error: "server error"
    });

  }

}
