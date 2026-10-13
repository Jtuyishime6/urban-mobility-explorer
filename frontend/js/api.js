// Summary stats and API configuration
document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = 'http://127.0.0.1:5000/api';
    
    // Make API_BASE available globally
    window.API_BASE = API_BASE;
    
    // Track active zone and sorting state
    window.activeZoneId = null;
    window.currentSort = {
        field: 'volume',
        direction: 'desc'
    };
    
    // DOM Elements
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const boroughFilter = document.getElementById('boroughFilter');
    const maxDistanceSlider = document.getElementById('maxDistanceSlider');
    const distanceBadge = document.getElementById('distanceBadge');
    const maxFareSlider = document.getElementById('maxFareSlider');
    const fareBadge = document.getElementById('fareBadge');
    const sortBySelect = document.getElementById('sortBySelect');
    const sortOrderBtn = document.getElementById('sortOrderBtn');
    const userBadge = document.getElementById('userBadge');

    // Display current user email if logged in
    const storedEmail = localStorage.getItem('user_email');
    if (storedEmail && userBadge) {
        userBadge.textContent = storedEmail;
    }

    // Distance and Fare slider live updates
    if (maxDistanceSlider && distanceBadge) {
        maxDistanceSlider.addEventListener('input', (e) => {
            distanceBadge.textContent = `${e.target.value} mi`;
            refreshDashboard();
        });
    }

    if (maxFareSlider && fareBadge) {
        maxFareSlider.addEventListener('input', (e) => {
            fareBadge.textContent = `$${e.target.value}`;
            refreshDashboard();
        });
    }

    // Sorting controls
    if (sortBySelect) {
        sortBySelect.addEventListener('change', (e) => {
            window.currentSort.field = e.target.value;
            refreshDashboard();
        });
    }

    if (sortOrderBtn) {
        sortOrderBtn.addEventListener('click', () => {
            window.currentSort.direction = window.currentSort.direction === 'desc' ? 'asc' : 'desc';
            const icon = document.getElementById('sortOrderIcon');
            if (icon) {
                icon.innerHTML = window.currentSort.direction === 'desc'
                    ? '<polyline points="6 9 12 15 18 9"></polyline>'
                    : '<polyline points="18 15 12 9 6 15"></polyline>';
            }
            refreshDashboard();
        });
    }
    
    // Fetch and update summary statistics
    async function updateSummary(zoneId = null) {
        try {
            window.activeZoneId = zoneId || window.activeZoneId;
            const startDate = startDateInput ? startDateInput.value : '2019-01-01';
            const endDate = endDateInput ? endDateInput.value : '2019-01-31';
            const borough = boroughFilter ? boroughFilter.value : 'all';

            const url = new URL(`${API_BASE}/trips/summary`);
            if (startDate) url.searchParams.append('start_date', startDate);
            if (endDate) url.searchParams.append('end_date', endDate);

            if (maxDistanceSlider) url.searchParams.append('max_distance', maxDistanceSlider.value);
            if (maxFareSlider) url.searchParams.append('max_fare', maxFareSlider.value);
            url.searchParams.append('sort_by', window.currentSort.field);
            url.searchParams.append('sort_order', window.currentSort.direction);

            // Zone ID takes priority over borough filter
            if (window.activeZoneId) {
                url.searchParams.append('zone_id', window.activeZoneId);
            } else if (borough !== 'all') {
                url.searchParams.append('borough', borough);
            }

            let data;
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`API Error: ${resp.status}`);
                data = await resp.json();
            } catch (fetchErr) {
                console.warn('Backend API unavailable, using fallback stats:', fetchErr.message);
                data = {
                    totalTrips: 7667792,
                    totalPassengers: 12056230,
                    systemHealth: 98.4,
                    avgMobilitySpeed: 12.8,
                    totalAnomalies: 1420,
                    anomalyDetails: { speed: 890, fare: 530 }
                };
            }

            // Update metric cards
            const healthElem = document.getElementById('systemHealth');
            const speedElem = document.getElementById('avgMobilitySpeed');
            const anomaliesElem = document.getElementById('totalAnomalies');
            const tripsElem = document.getElementById('totalTripsHeader');
            const passengersElem = document.getElementById('totalPassengersHeader');

            if (healthElem) healthElem.textContent = `${data.systemHealth || 0}%`;
            if (speedElem) speedElem.textContent = `${data.avgMobilitySpeed || 0} MPH`;
            if (anomaliesElem) anomaliesElem.textContent = (data.totalAnomalies || 0).toLocaleString();
            if (tripsElem) tripsElem.textContent = (data.totalTrips || 0).toLocaleString();
            if (passengersElem) passengersElem.textContent = (data.totalPassengers || 0).toLocaleString();

            // Show/hide no data alert
            const noDataAlert = document.getElementById('noDataAlert');
            if (noDataAlert) {
                if (data.totalTrips === 0) {
                    noDataAlert.classList.remove('hidden');
                } else {
                    noDataAlert.classList.add('hidden');
                }
            }

            // Update anomaly tooltip details
            if (data.anomalyDetails) {
                const speedAnom = document.getElementById('speedAnomCount');
                const fareAnom = document.getElementById('fareAnomCount');
                if (speedAnom) speedAnom.textContent = (data.anomalyDetails.speed || 0).toLocaleString();
                if (fareAnom) fareAnom.textContent = (data.anomalyDetails.fare || 0).toLocaleString();
            }

            // Remove loading state
            [healthElem, speedElem, anomaliesElem, tripsElem, passengersElem].forEach(el => {
                if (el) {
                    const card = el.closest('.stat-card');
                    if (card) card.classList.remove('loading');
                }
            });

            // Color-code health score
            if (healthElem) {
                const healthCard = healthElem.closest('.stat-card');
                if (healthCard) {
                    if (data.systemHealth < 95) {
                        healthCard.style.color = '#ff7b72';
                    } else {
                        healthCard.style.color = '#3fb950';
                    }
                }
            }
        } catch (err) {
            console.error('Error fetching summary:', err);
        }
    }

    // Debounce helper
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Refresh dashboard when filters change
    const refreshDashboard = debounce(() => {
        updateSummary();
        if (window.loadChart) window.loadChart();
        if (window.loadCoverageGaps) window.loadCoverageGaps();
        console.log("Dashboard refreshed");
    }, 350);

    if (startDateInput) startDateInput.addEventListener('change', refreshDashboard);
    if (endDateInput) endDateInput.addEventListener('change', refreshDashboard);

    if (boroughFilter) {
        boroughFilter.addEventListener('change', () => {
            updateSummary();
            if (window.loadChart) window.loadChart();
            if (window.loadCoverageGaps) window.loadCoverageGaps();
            if (window.updateMapFilter) window.updateMapFilter();
        });
    }

    // Make updateSummary available globally
    window.updateSummary = updateSummary;
    
    // Initial load
    updateSummary();
});
