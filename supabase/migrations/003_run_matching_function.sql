-- SQL function untuk matching RUP-Realisasi
-- Berjalan di PostgreSQL server, tidak dibatasi Edge Function memory

CREATE OR REPLACE FUNCTION run_matching(p_periode TEXT)
RETURNS TABLE(matched INT, unmatched INT, orphan INT) AS $$
DECLARE
  v_matched INT := 0;
  v_unmatched INT := 0;
  v_orphan INT := 0;
  v_now TIMESTAMPTZ := NOW();
  rec RECORD;
  rup_rec RECORD;
  v_kode_rup TEXT;
  v_pagu NUMERIC;
  v_nama_paket_rup TEXT;
  v_found BOOLEAN;
BEGIN
  -- Step 1: Delete old matching results
  DELETE FROM matching_results WHERE periode = p_periode;

  -- Step 2: EXACT MATCH by kode_rup
  -- Insert matched realisasi records that have a kode_rup matching in rup_records
  INSERT INTO matching_results (
    matching_id, periode, kode_satker, nama_satker, kode_rup, kode_paket,
    nama_paket_rup, nama_paket_realisasi, metode_matching, similarity_score,
    pagu_rup, nilai_kontrak, efisiensi, persen_efisiensi, status_matching, created_at
  )
  SELECT
    gen_random_uuid(), r.periode, r.kode_satker, r.nama_satker,
    COALESCE(p.kode_rup, r.kode_rup), r.kode_paket,
    p.nama_paket, r.nama_paket,
    'EXACT_ID', NULL,
    p.pagu, r.nilai_kontrak,
    p.pagu - r.nilai_kontrak,
    CASE WHEN p.pagu > 0 THEN ROUND((p.pagu - r.nilai_kontrak)::NUMERIC / p.pagu * 100, 2) ELSE 0 END,
    'MATCHED', v_now
  FROM realisasi_records r
  JOIN rup_records p ON p.periode = r.periode AND TRIM(p.kode_rup) = TRIM(r.kode_rup)
  WHERE r.periode = p_periode
    AND r.kode_rup IS NOT NULL AND TRIM(r.kode_rup) <> '';

  GET DIAGNOSTICS v_matched = ROW_COUNT;

  -- Step 3: UNMATCHED realisasi (kode_rup exists but no match in RUP, or no kode_rup)
  INSERT INTO matching_results (
    matching_id, periode, kode_satker, nama_satker, kode_rup, kode_paket,
    nama_paket_rup, nama_paket_realisasi, metode_matching, similarity_score,
    pagu_rup, nilai_kontrak, efisiensi, persen_efisiensi, status_matching, created_at
  )
  SELECT
    gen_random_uuid(), r.periode, r.kode_satker, r.nama_satker,
    r.kode_rup, r.kode_paket,
    NULL, r.nama_paket,
    CASE
      WHEN r.kode_rup IS NULL OR TRIM(r.kode_rup) = '' THEN 'ORPHAN'
      ELSE 'UNMATCHED'
    END,
    NULL,
    NULL, r.nilai_kontrak,
    NULL, NULL,
    'UNMATCHED', v_now
  FROM realisasi_records r
  WHERE r.periode = p_periode
    AND NOT EXISTS (
      SELECT 1 FROM matching_results m
      WHERE m.periode = r.periode AND m.kode_paket = r.kode_paket
    );

  GET DIAGNOSTICS v_unmatched = ROW_COUNT;

  -- Step 4: ORPHAN RUP (RUP records not matched to any realisasi)
  INSERT INTO matching_results (
    matching_id, periode, kode_satker, nama_satker, kode_rup, kode_paket,
    nama_paket_rup, nama_paket_realisasi, metode_matching, similarity_score,
    pagu_rup, nilai_kontrak, efisiensi, persen_efisiensi, status_matching, created_at
  )
  SELECT
    gen_random_uuid(), p.periode, p.kode_satker, p.nama_satker,
    p.kode_rup, NULL,
    p.nama_paket, NULL,
    'UNMATCHED', NULL,
    p.pagu, NULL,
    NULL, NULL,
    'UNMATCHED', v_now
  FROM rup_records p
  WHERE p.periode = p_periode
    AND NOT EXISTS (
      SELECT 1 FROM matching_results m
      WHERE m.periode = p.periode AND m.kode_rup = p.kode_rup AND m.status_matching = 'MATCHED'
    );

  GET DIAGNOSTICS v_orphan = ROW_COUNT;

  RETURN QUERY SELECT v_matched, v_unmatched, v_orphan;
END;
$$ LANGUAGE plpgsql;
