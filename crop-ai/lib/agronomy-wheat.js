'use strict';
/**
 * Wheat advisor. Pure: no network, no I/O, so every rule is unit-tested.
 *
 * Inputs
 *   indices  { healthyPct, stressedPct, barePct, waterPct, ndviMean, ndviMin, bsiMean }
 *            from the satellite analysis (Sentinel-2, inside the drawn area)
 *   weather  { rainLast7dMm, rainNext7dMm, tempMinC, tempMaxC, windKmh } or null
 *   soil     { ph, organicCarbonPct, nitrogenKgHa, olsenPPm, exchangeableKPm, zincDtpaPpm }
 *            optional lab values. Anything not supplied is reported as an unknown.
 *
 * Output: { findings[], unknowns[], timing[], confidence, notes[] }.
 *
 * Thresholds are standard cereal advisory ranges (DTPA zinc, Olsen P, exchangeable K,
 * soil pH). They are guidance for a trained agronomist to confirm against a local
 * soil test, not a substitute for one.
 */

const ZINC_DEFICIENT = 0.6;  // mg/kg DTPA-Zn, below this a cereal response is likely
const ZINC_MARGINAL = 1.0;   // mg/kg DTPA-Zn, 0.6–1.0 marginal

function finding(o) {
  return { severity: 'info', confidence: 'medium', source: 'rule', ...o };
}

/** Satellite-derived crop condition. Pure. */
function cropCondition(ix) {
  const out = [];
  if (!ix) return out;
  if (ix.ndviMean != null && ix.ndviMean < 0.4) {
    out.push(finding({
      id: 'canopy-vigour-low',
      severity: ix.ndviMean < 0.3 ? 'high' : 'medium',
      title: `Low canopy vigour (mean NDVI ${ix.ndviMean.toFixed(2)})`,
      evidence: `Healthy closed canopy in Sentinel-2 is usually above 0.5 mid-season; the area averages ${ix.ndviMean.toFixed(2)}.`,
      action: 'Scout a few plots on foot. Nitrogen deficiency and water stress both lower NDVI, so check leaf colour and soil moisture before choosing a fix.',
    }));
  }
  if (ix.stressedPct != null && ix.stressedPct >= 25) {
    out.push(finding({
      id: 'stressed-share-high',
      severity: 'medium',
      title: `${ix.stressedPct}% of the area is stressed canopy`,
      evidence: 'Stressed pixels have NDVI 0.15–0.35: thin or yellowing crop, not bare ground.',
      action: 'Compare the stressed patches with the field map. Patches that follow a drainage line point to waterlogging; patches on a knoll point to drought or low fertility.',
    }));
  }
  if (ix.barePct != null && ix.barePct >= 15) {
    out.push(finding({
      id: 'bare-share-high',
      severity: 'medium',
      title: `${ix.barePct}% of the area is bare ground`,
      evidence: 'Bare pixels have NDVI below 0.15 — gaps in the stand, a failed establishment, or harvested or fallow ground.',
      action: 'If the crop should be established, check seed rate and drilling uniformity. Gaps early in the season can be patched with re-drilling.',
    }));
  }
  return out;
}

/** Lab-measured soil fertility. Each key is only judged when a value was supplied. Pure. */
function soilFertility(soil) {
  const out = [];
  const unknowns = [];
  if (!soil) {
    return {
      out,
      unknowns: [
        'Zinc (DTPA-Zn) was not tested. Satellite imagery cannot measure zinc, so a zinc deficiency cannot be confirmed or ruled out.',
        'No soil lab results were entered: pH and nutrient levels cannot be judged from satellite imagery.',
      ],
    };
  }

  if (soil.zincDtpaPpm == null) {
    unknowns.push('Zinc (DTPA-Zn) was not tested. Satellite imagery cannot measure zinc, so a zinc deficiency cannot be confirmed or ruled out.');
  } else if (soil.zincDtpaPpm < ZINC_DEFICIENT) {
    out.push(finding({
      id: 'zinc-deficient',
      severity: 'high',
      confidence: 'high',
      source: 'lab',
      title: `Zinc deficient (DTPA-Zn ${soil.zincDtpaPpm} mg/kg, below ${ZINC_DEFICIENT})`,
      evidence: 'Cereals on zinc-deficient soils show pale, streaked young leaves and poor tillering, and the canopy stays below its potential.',
      action: 'Apply zinc sulphate (ZnSO₄·H₂O) at about 25 kg/ha broadcast before sowing, or a 0.5% ZnSO₄ foliar spray at tillering as a faster correction. Confirm the rate with your local agronomist.',
    }));
  } else if (soil.zincDtpaPpm < ZINC_MARGINAL) {
    out.push(finding({
      id: 'zinc-marginal',
      severity: 'medium',
      confidence: 'high',
      source: 'lab',
      title: `Zinc marginal (DTPA-Zn ${soil.zincDtpaPpm} mg/kg)`,
      evidence: 'Marginal zinc is often enough, but yield loss is likely in a dry or cold spring.',
      action: 'A preventive 0.5% ZnSO₄ foliar spray at tillering costs little and removes the risk.',
    }));
  }

  if (soil.ph != null) {
    if (soil.ph < 5.5) {
      out.push(finding({
        id: 'ph-acid',
        severity: 'medium',
        confidence: 'high',
        source: 'lab',
        title: `Acid soil (pH ${soil.ph})`,
        evidence: 'Below pH 5.5 aluminium and manganese become toxic and phosphorus is locked up.',
        action: 'Apply agricultural lime, sized by a buffer-pH test. Lime works slowly, so plan it before the next sowing.',
      }));
    } else if (soil.ph > 8.2) {
      out.push(finding({
        id: 'ph-alkaline',
        severity: 'medium',
        confidence: 'high',
        source: 'lab',
        title: `Alkaline soil (pH ${soil.ph})`,
        evidence: 'Above pH 8.2 zinc, iron and phosphorus availability drop sharply.',
        action: 'Gypsum helps on sodic soils; elemental sulphur helps lower pH slowly. Foliar zinc is more reliable than soil zinc here.',
      }));
    }
  } else {
    unknowns.push('Soil pH was not entered.');
  }

  if (soil.olsenPPm != null && soil.olsenPPm < 10) {
    out.push(finding({
      id: 'phosphorus-low',
      severity: 'medium',
      confidence: 'high',
      source: 'lab',
      title: `Phosphorus low (Olsen P ${soil.olsenPPm} mg/kg)`,
      evidence: 'Below 10 mg/kg Olsen P, wheat responds to a basal phosphorus dressing.',
      action: 'Apply DAP or single superphosphate at sowing, about 40–60 kg P₂O₅/ha. Band it near the seed row.',
    }));
  }
  if (soil.exchangeableKPm != null && soil.exchangeableKPm < 100) {
    out.push(finding({
      id: 'potassium-low',
      severity: 'medium',
      confidence: 'high',
      source: 'lab',
      title: `Potassium low (exchangeable K ${soil.exchangeableKPm} mg/kg)`,
      evidence: 'Below 100 mg/kg exchangeable K, wheat yields and stem strength suffer.',
      action: 'Apply muriate of potash (MOP) at about 40–60 kg K₂O/ha at sowing.',
    }));
  }
  if (soil.organicCarbonPct != null && soil.organicCarbonPct < 1) {
    out.push(finding({
      id: 'organic-carbon-low',
      severity: 'low',
      confidence: 'high',
      source: 'lab',
      title: `Low organic carbon (${soil.organicCarbonPct}%)`,
      evidence: 'Below 1% organic carbon, the soil holds less water and nutrient.',
      action: 'Return crop residue, add farmyard manure where available, and avoid burning stubble.',
    }));
  }
  return { out, unknowns };
}

/** Nitrogen top-dressing advice from canopy vigour, scaled by weather. Pure. */
function nitrogenAdvice(ix, weather) {
  if (!ix || ix.ndviMean == null) return [];
  if (ix.ndviMean >= 0.5) return [];
  const rain = weather?.rainLast7dMm;
  // Waterlogged soil loses applied nitrogen; a dry spell delays uptake. Say so rather than hide it.
  const caution = rain != null && rain > 40 ? ' Heavy recent rain means nitrogen may already have leached; check the canopy again in a week before adding more.' : '';
  return [finding({
    id: 'nitrogen-topdress',
    severity: ix.ndviMean < 0.35 ? 'high' : 'medium',
    title: 'Nitrogen top-dressing likely needed',
    evidence: `Mean NDVI ${ix.ndviMean.toFixed(2)} is below the 0.50 a well-fed wheat canopy reaches mid-season.`,
    action: `Top-dress 40–60 kg N/ha (urea or CAN) at the start of stem extension, after a dry spell if possible.${caution}`,
    confidence: 'medium',
  })];
}

/** Spraying and weather constraints, when weather is available. Pure. */
function weatherConstraints(weather) {
  const out = [];
  if (!weather) return out;
  if (weather.windKmh != null && weather.windKmh > 15) {
    out.push(finding({
      id: 'spray-wind',
      severity: 'info',
      title: `Wind ${Math.round(weather.windKmh)} km/h — too windy to spray`,
      evidence: 'Spray drift is a real risk above about 15 km/h.',
      action: 'Schedule foliar zinc or any spray for a calmer morning.',
      source: 'weather',
    }));
  }
  if (weather.tempMinC != null && weather.tempMinC <= 2) {
    out.push(finding({
      id: 'frost-risk',
      severity: 'medium',
      title: `Overnight low of ${weather.tempMinC}°C — frost risk`,
      evidence: 'Frost on a wheat crop at tillering or stem extension can cut yield.',
      action: 'Hold off on foliar sprays and fresh nitrogen until the risk passes.',
      source: 'weather',
    }));
  }
  if (weather.rainNext7dMm != null && weather.rainNext7dMm >= 25) {
    out.push(finding({
      id: 'rain-expected',
      severity: 'info',
      title: `${weather.rainNext7dMm} mm of rain forecast in the next 7 days`,
      evidence: 'Soil-applied fertilizer dissolves and moves with heavy rain.',
      action: 'Split nitrogen into smaller doses if rain is due, and avoid broadcasting soluble products just before it.',
      source: 'weather',
    }));
  }
  return out;
}

/** Overall confidence: lab results raise it; a short or cloudy scene lowers it. Pure. */
function overallConfidence(ix, soil) {
  if (!ix) return 'none';
  if (soil && soil.zincDtpaPpm != null) return 'medium';
  return 'low';
}

/** Full advice bundle. Pure. */
function adviseWheat({ indices, weather = null, soil = null }) {
  const soilPart = soilFertility(soil);
  const findings = [
    ...cropCondition(indices),
    ...soilPart.out,
    ...nitrogenAdvice(indices, weather),
    ...weatherConstraints(weather),
  ];
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const unknowns = [...soilPart.unknowns];
  unknowns.push('Satellite pixels cannot see soil chemistry: micronutrient, nutrient and pH values only come from a soil test.');
  return {
    crop: 'wheat',
    findings,
    unknowns,
    confidence: overallConfidence(indices, soil),
    notes: [
      'Advice is rule-based guidance from satellite indices, live weather and any entered lab results. It is not a prescription.',
      'Confirm fertilizer rates against your local soil test and agronomist before applying.',
    ],
  };
}

module.exports = {
  adviseWheat,
  cropCondition,
  soilFertility,
  nitrogenAdvice,
  weatherConstraints,
  ZINC_DEFICIENT,
  ZINC_MARGINAL,
};
