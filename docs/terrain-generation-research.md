# Terrain Generation Research for Artillery-Style Gameplay

## Goal

Identify terrain generation approaches that fit a 2D artillery game where match fairness, shot readability, and deterministic replay are first-order product outcomes.

## Candidate Techniques

1. Fractal terrain synthesis (midpoint displacement / spectral methods)
- Strength: creates natural large-scale silhouettes with little input data.
- Tradeoff: can produce sharp artifacts unless constrained for gameplay.
- Source: Fournier, Fussell, Carpenter (1982), *Computer Rendering of Stochastic Models*.

2. Gradient coherent noise (Perlin noise, layered/octave composition)
- Strength: fine control over visual roughness and strategic terrain variation.
- Tradeoff: needs product constraints for spawn fairness and minimum traversal/playability.
- Sources: Perlin (1985), *An Image Synthesizer*; Perlin (2002), *Improving Noise*.

3. Physically inspired erosion passes
- Strength: improves plausibility of ridges and valleys after base generation.
- Tradeoff: heavier compute and harder to keep deterministic/perf-stable in real-time match creation.
- Source: Jako (2011), *Fast Hydraulic and Thermal Erosion on GPU*.

4. Deterministic PRNG for reproducible generation
- Strength: stable seed-to-terrain mapping for replay verification and debugging.
- Tradeoff: requires explicit generator selection and seed lifecycle policy.
- Source: O'Neill (2014), *PCG: A Family of Better Random Number Generators*.

## Fit for This Project

Inference from the sources above and current project constraints:

- Best phase-1 fit is a deterministic, high-resolution 1D terrain profile generated from layered coherent noise with strict playability constraints.
- Deformation should stay local and smooth to preserve tactical readability after impacts.
- Erosion passes are better treated as phase-2 enhancements after base determinism and latency budgets are consistently met.

## Sources

- Perlin 1985: [https://dl.acm.org/doi/10.1145/325334.325247](https://dl.acm.org/doi/10.1145/325334.325247)
- Perlin 2002: [https://dl.acm.org/doi/10.1145/566654.566636](https://dl.acm.org/doi/10.1145/566654.566636)
- Fournier et al. 1982: [https://dl.acm.org/doi/10.1145/358523.358553](https://dl.acm.org/doi/10.1145/358523.358553)
- Jako 2011: [https://diglib.eg.org/items/60afda0c-a666-4df8-90dd-9b80afc554c2](https://diglib.eg.org/items/60afda0c-a666-4df8-90dd-9b80afc554c2)
- O'Neill 2014 (PCG): [https://www.pcg-random.org/paper.html](https://www.pcg-random.org/paper.html)
