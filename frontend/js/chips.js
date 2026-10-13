// Quick filter chips functionality
document.addEventListener('DOMContentLoaded', () => {
    const emptyState = document.getElementById('emptyState');
    let activeFilter = 'all';
    
    function getGapZones() {
        return window.gapZones || [];
    }

    // Filter chips
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            activeFilter = chip.dataset.filter;
            applyQuickFilter(activeFilter);
        });
    });

    // Apply quick filter to map
    function applyQuickFilter(filter) {
        if (!window.geoLayer) return;

        const gapZones = getGapZones();
        let visibleCount = 0;

        window.geoLayer.eachLayer(layer => {
            const zoneName = layer.feature.properties.zone;
            const isGap = gapZones.find(g => g.zone === zoneName);
            let show = false;

            if (filter === 'all') {
                show = true;
            } else if (filter === 'underserved') {
                show = !!isGap;
            } else if (filter === 'normal') {
                show = !isGap;
            }

            if (show) {
                layer.setStyle({ 
                    opacity: 1, 
                    fillOpacity: isGap ? 0.6 : 0.25 
                });
                visibleCount++;
            } else {
                layer.setStyle({ 
                    opacity: 0.1, 
                    fillOpacity: 0.03 
                });
            }
        });

        // Show empty state if no zones visible
        if (emptyState) {
            emptyState.style.display = visibleCount === 0 ? 'flex' : 'none';
        }
    }

    window.applyQuickFilter = applyQuickFilter;
});
