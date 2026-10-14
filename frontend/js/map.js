// Map initialization and zone management
document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = window.API_BASE || 'http://127.0.0.1:5000/api';
    
    // Create map centered on NYC
    const map = L.map('map').setView([40.7128, -74.0060], 11);
    
    // Dark Gray basemap - 100% free, no API key, no watermark
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        maxZoom: 16
    }).addTo(map);

    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const boroughFilter = document.getElementById('boroughFilter');
    const boroughMenu = document.getElementById('boroughMenu');
    const selectedBoroughSpan = document.getElementById('selectedBorough');
    const hoverTooltip = document.getElementById('hoverTooltip');
    const loadingState = document.getElementById('loadingState');
    const detailsPanel = document.getElementById('detailsPanel');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const controlsSection = document.querySelector('.controls');

    // Prevent map scroll when using controls
    if (boroughMenu) L.DomEvent.disableScrollPropagation(boroughMenu);
    if (controlsSection) {
        L.DomEvent.disableScrollPropagation(controlsSection);
        L.DomEvent.disableClickPropagation(controlsSection);
    }

    let geoLayer;
    let gapZones = [];
    
    window.allZones = [];

    // Load zones from API with SAMPLE_ZONES fallback
    async function loadZones() {
        console.log("Loading NYC taxi zones...");
        if (loadingState) loadingState.classList.remove('hidden');
        
        let zones = [];
        try {
            const resp = await fetch(`${API_BASE}/zones`);
            if (!resp.ok) throw new Error(`API Error: ${resp.status}`);
            zones = await resp.json();
        } catch (err) {
            console.warn("Backend API zones endpoint unavailable, using sample zones:", err.message);
            zones = window.SAMPLE_ZONES || [];
        }

        window.allZones = zones;

        const featureCollection = {
            type: 'FeatureCollection',
            features: zones.map(zone => ({
                type: 'Feature',
                geometry: zone.geometry,
                properties: {
                    id: zone.id,
                    borough: zone.borough,
                    zone: zone.zone
                }
            }))
        };

        if (geoLayer) {
            map.removeLayer(geoLayer);
        }

        geoLayer = L.geoJSON(featureCollection, {
            style: () => ({
                color: '#c9d1d9',
                weight: 1,
                fillOpacity: 0.15,
                fillColor: '#58a6ff'
            }),
            onEachFeature: (feature, layer) => {
                // Hover tooltip
                layer.on('mouseover', (e) => {
                    if (detailsPanel && detailsPanel.classList.contains('open') && 
                        String(window.activeZoneId) === String(feature.properties.id)) {
                        if (hoverTooltip) hoverTooltip.classList.remove('visible');
                        return;
                    }

                    const props = feature.properties;
                    const gap = gapZones.find(g => g.zone === props.zone);
                    const status = gap ? '⚠️ Underserved' : '✓ Normal Coverage';

                    if (hoverTooltip) {
                        hoverTooltip.innerHTML = `
                            <strong>${props.zone}</strong><br>
                            <small>${props.borough}</small><br>
                            <small>${status}</small>
                        `;
                        hoverTooltip.classList.add('visible');
                        updateTooltipPosition(e.originalEvent);
                    }
                });

                layer.on('mousemove', (e) => {
                    if (hoverTooltip && hoverTooltip.classList.contains('visible')) {
                        updateTooltipPosition(e.originalEvent);
                    }
                });

                layer.on('mouseout', () => {
                    if (hoverTooltip) hoverTooltip.classList.remove('visible');
                });

                // Click to open details panel
                layer.on('click', () => {
                    if (hoverTooltip) hoverTooltip.classList.remove('visible');
                    const props = feature.properties;
                    if (selectedBoroughSpan) selectedBoroughSpan.textContent = props.zone;
                    if (boroughFilter) boroughFilter.value = 'all';
                    
                    if (window.updateSummary) window.updateSummary(props.id);
                    if (window.loadChart) window.loadChart();
                    if (window.openDetailsPanel) window.openDetailsPanel(props);
                });

                layer.bindPopup(`<b>${feature.properties.zone}</b><br>${feature.properties.borough}`);
            }
        }).addTo(map);

        window.geoLayer = geoLayer;

        if (zones.length > 0 && geoLayer.getBounds().isValid()) {
            map.fitBounds(geoLayer.getBounds());
        }

        if (loadingState) loadingState.classList.add('hidden');
        await loadCoverageGaps();
    }

    // Load coverage gaps (underserved areas)
    async function loadCoverageGaps() {
        try {
            const startDate = startDateInput ? startDateInput.value : '';
            const endDate = endDateInput ? endDateInput.value : '';
            const borough = boroughFilter ? boroughFilter.value : 'all';

            const url = new URL(`${API_BASE}/trips/gaps`);
            if (startDate) url.searchParams.append('start_date', startDate);
            if (endDate) url.searchParams.append('end_date', endDate);
            if (borough !== 'all') url.searchParams.append('borough', borough);
            if (window.activeZoneId) url.searchParams.append('zone_id', window.activeZoneId);

            let gaps = [];
            try {
                const resp = await fetch(url);
                if (resp.ok) gaps = await resp.json();
            } catch (e) {
                // Mock fallback gaps
                gaps = [
                    { zone: "Astoria", borough: "Queens", coverageRatio: 0.35 },
                    { zone: "St. George", borough: "Staten Island", coverageRatio: 0.22 },
                    { zone: "Yankee Stadium", borough: "Bronx", coverageRatio: 0.41 }
                ];
            }

            gapZones = gaps;
            window.gapZones = gaps;

            updateMapFilter();
        } catch (err) { 
            console.error("Error loading coverage gaps:", err); 
        }
    }

    // Update map styling based on filters
    function updateMapFilter() {
        if (!geoLayer) return;
        const selectedBorough = boroughFilter ? boroughFilter.value : 'all';
        const filteredLayers = [];

        geoLayer.eachLayer((layer) => {
            const props = layer.feature.properties;
            const borough = props.borough;
            const isActive = (selectedBorough === 'all' || borough === selectedBorough);

            const isGap = gapZones.find(g => g.zone === props.zone);
            const baseColor = isGap ? '#f0883e' : '#58a6ff';
            const outlineColor = isGap ? '#f0883e' : '#c9d1d9';

            if (isActive) {
                layer.setStyle({
                    color: outlineColor,
                    fillColor: baseColor,
                    weight: selectedBorough === 'all' ? (isGap ? 2 : 1) : 3,
                    fillOpacity: selectedBorough === 'all' ? (isGap ? 0.5 : 0.15) : 0.4
                });
                filteredLayers.push(layer);
            } else {
                layer.setStyle({
                    color: '#c9d1d9',
                    fillColor: baseColor,
                    weight: 0.5,
                    fillOpacity: 0.02
                });
            }
        });

        if (filteredLayers.length > 0 && selectedBorough !== 'all') {
            const group = L.featureGroup(filteredLayers);
            if (group.getBounds().isValid()) {
                map.fitBounds(group.getBounds(), { padding: [20, 20] });
            }
        } else if (selectedBorough === 'all' && geoLayer && geoLayer.getBounds().isValid()) {
            map.fitBounds(geoLayer.getBounds());
        }
    }

    // Helper: Update tooltip position
    function updateTooltipPosition(event) {
        if (!hoverTooltip) return;
        const offset = 15;
        hoverTooltip.style.left = (event.clientX + offset) + 'px';
        hoverTooltip.style.top = (event.clientY + offset) + 'px';
    }

    // Helper: Zoom to specific zone
    function zoomToZone(zoneId) {
        if (!geoLayer) return;
        geoLayer.eachLayer(layer => {
            if (parseInt(layer.feature.properties.id) === parseInt(zoneId)) {
                map.fitBounds(layer.getBounds(), { padding: [50, 50] });
                layer.openPopup();
                if (window.openDetailsPanel) {
                    window.openDetailsPanel(layer.feature.properties);
                }
            }
        });
    }

    // Focus mode toggle
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            document.body.classList.toggle('focus-mode');
            const isFocus = document.body.classList.contains('focus-mode');

            fullscreenBtn.innerHTML = isFocus
                ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
                : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;

            setTimeout(() => {
                map.invalidateSize();
                if (geoLayer && geoLayer.getBounds().isValid()) {
                    map.fitBounds(geoLayer.getBounds());
                }
            }, 300);
        });
    }

    // Mobile filter toggle
    const mobileFilterToggle = document.getElementById('mobileFilterToggle');
    if (mobileFilterToggle && controlsSection) {
        mobileFilterToggle.addEventListener('click', () => {
            controlsSection.classList.toggle('open');
            mobileFilterToggle.classList.toggle('open');
            const isExpanded = controlsSection.classList.contains('open');
            const span = mobileFilterToggle.querySelector('span');
            if (span) span.textContent = isExpanded ? 'Hide Filters' : 'Filter Options';
        });
    }

    // Make functions available globally
    window.loadCoverageGaps = loadCoverageGaps;
    window.updateMapFilter = updateMapFilter;
    window.zoomToZone = zoomToZone;
    
    // Initialize
    loadZones().then(() => {
        updateMapFilter();
    });
});
