// Report generation functionality
document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = window.API_BASE || 'http://127.0.0.1:5000/api';
    
    const generateReportBtn = document.getElementById('generateReportBtn');
    const reportModal = document.getElementById('reportModal');
    const closeReportBtn = document.getElementById('closeReportBtn');
    const printReportBtn = document.getElementById('printReportBtn');
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const boroughFilter = document.getElementById('boroughFilter');
    
    let reportChartInstance = null;

    // Generate diagnostic report
    async function generateReport() {
        const startDate = startDateInput ? startDateInput.value : '2019-01-01';
        const endDate = endDateInput ? endDateInput.value : '2019-01-31';
        const borough = boroughFilter ? boroughFilter.value : 'all';

        const url = new URL(`${API_BASE}/report`);
        if (startDate) url.searchParams.append('start_date', startDate);
        if (endDate) url.searchParams.append('end_date', endDate);
        if (borough !== 'all') url.searchParams.append('borough', borough);
        if (window.activeZoneId) url.searchParams.append('zone_id', window.activeZoneId);

        try {
            if (generateReportBtn) {
                generateReportBtn.disabled = true;
                generateReportBtn.textContent = "Processing...";
            }

            let data;
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Report fetch error");
                data = await resp.json();
            } catch (fetchErr) {
                console.warn("Backend report endpoint unavailable, using mock report:", fetchErr.message);
                const isZone = !!window.activeZoneId;
                data = {
                    metadata: {
                        scope: isZone ? "Selected Taxi Zone" : (borough !== 'all' ? borough : "Citywide"),
                        period: `${startDate} to ${endDate}`,
                        generatedAt: new Date().toLocaleString(),
                        isZoneReport: isZone,
                        isCitywide: borough === 'all' && !isZone,
                        comparison: isZone ? { zoneSpeed: 11.2, boroughSpeed: 12.8, diff: -12.5 } : null,
                        boroughMetadata: borough !== 'all' ? { zoneCount: 45, pickupPassengers: 245000, dropoffPassengers: 231000 } : null
                    },
                    summary: {
                        totalTrips: 7667792,
                        totalPassengers: 12056230,
                        totalRevenue: 135402100,
                        avgSpeed: 12.8,
                        avgDistance: 2.95,
                        totalAnomalies: 1420,
                        systemHealth: 98.4,
                        anomalyDetails: { speed: 890, fare: 530 }
                    },
                    topZones: [
                        { zone: "Upper East Side South", borough: "Manhattan", trips: 312450, speed: 10.4 },
                        { zone: "Midtown Center", borough: "Manhattan", trips: 298100, speed: 8.9 },
                        { zone: "JFK Airport", borough: "Queens", trips: 245900, speed: 26.5 },
                        { zone: "Times Square", borough: "Manhattan", trips: 221300, speed: 7.8 },
                        { zone: "LaGuardia Airport", borough: "Queens", trips: 198400, speed: 21.2 }
                    ],
                    rushHour: {
                        hour: 18,
                        trips: 68400,
                        avgSpeed: 8.4,
                        congestionImpact: -34.2,
                        trend: {
                            0: { trips: 12000 }, 1: { trips: 8000 }, 2: { trips: 5500 }, 3: { trips: 4200 },
                            4: { trips: 4800 }, 5: { trips: 8500 }, 6: { trips: 18000 }, 7: { trips: 35000 },
                            8: { trips: 52000 }, 9: { trips: 48000 }, 10: { trips: 41000 }, 11: { trips: 43000 },
                            12: { trips: 45000 }, 13: { trips: 44000 }, 14: { trips: 47000 }, 15: { trips: 51000 },
                            16: { trips: 56000 }, 17: { trips: 64000 }, 18: { trips: 68400 }, 19: { trips: 62000 },
                            20: { trips: 54000 }, 21: { trips: 46000 }, 22: { trips: 38000 }, 23: { trips: 24000 }
                        }
                    },
                    coverageGaps: [
                        { zone: "Astoria", borough: "Queens", ratio: 2.8 },
                        { zone: "St. George", borough: "Staten Island", ratio: 3.4 },
                        { zone: "Yankee Stadium", borough: "Bronx", ratio: 2.4 }
                    ]
                };
            }

            // Populate metadata
            const reportMetadata = document.getElementById('reportMetadata');
            if (reportMetadata) {
                reportMetadata.innerHTML = `
                    Scope: <strong>${data.metadata.scope}</strong> | 
                    Period: <strong>${data.metadata.period}</strong> | 
                    Generated: <strong>${data.metadata.generatedAt}</strong>
                    ${data.metadata.boroughMetadata && data.metadata.boroughMetadata.zoneCount ? 
                        ` | Total Zones: <strong>${data.metadata.boroughMetadata.zoneCount}</strong>` : ''}
                `;
            }

            // Populate summary grid
            const summaryGrid = document.getElementById('reportSummary');
            if (summaryGrid) {
                const metrics = [
                    { label: 'Total Trips', val: (data.summary.totalTrips || 0).toLocaleString() },
                    { label: 'Total Passengers', val: (data.summary.totalPassengers || 0).toLocaleString() },
                    { label: 'Gross Revenue', val: `$${(data.summary.totalRevenue || 0).toLocaleString()}` },
                    { label: 'Avg Mobility Speed', val: `${data.summary.avgSpeed} MPH` },
                    { label: 'Avg Distance', val: `${data.summary.avgDistance} MI` },
                    { label: 'Detected Noise', val: (data.summary.totalAnomalies || 0).toLocaleString() },
                    { label: 'Health Score', val: `${data.summary.systemHealth}%` },
                ];

                if (data.metadata.isZoneReport && data.metadata.comparison) {
                    metrics.push({ label: 'Zone Speed', val: `${data.metadata.comparison.zoneSpeed} MPH` });
                    metrics.push({ label: 'Borough Speed', val: `${data.metadata.comparison.boroughSpeed} MPH` });
                    metrics.push({ label: 'Speed Delta vs Borough', val: `${data.metadata.comparison.diff}%` });
                }

                if (data.metadata.boroughMetadata && data.metadata.boroughMetadata.pickupPassengers !== undefined) {
                    metrics.push({ label: 'Total Zones', val: data.metadata.boroughMetadata.zoneCount });
                    metrics.push({ label: 'PU Passengers', val: data.metadata.boroughMetadata.pickupPassengers.toLocaleString() });
                    metrics.push({ label: 'DO Passengers', val: data.metadata.boroughMetadata.dropoffPassengers.toLocaleString() });
                }

                summaryGrid.innerHTML = metrics.map(m => `
                    <div class="report-stat-card">
                        <small>${m.label}</small>
                        <strong>${m.val}</strong>
                    </div>
                `).join('');
            }

            // Populate top zones table
            const tbody = document.querySelector('#reportTopZones tbody');
            if (tbody && data.topZones) {
                tbody.innerHTML = data.topZones.map(z => `
                    <tr>
                        <td><strong>${z.zone}</strong></td>
                        <td>${z.borough}</td>
                        <td>${(z.trips || 0).toLocaleString()}</td>
                        <td>${z.speed} MPH</td>
                    </tr>
                `).join('');
            }

            // Populate rush hour
            const rushHourGrid = document.getElementById('reportRushHour');
            const rh = data.rushHour;
            if (rushHourGrid && rh) {
                const startHour = rh.hour.toString().padStart(2, '0') + ":00";
                const endHour = ((rh.hour + 1) % 24).toString().padStart(2, '0') + ":00";

                rushHourGrid.innerHTML = `
                    <div class="report-stat-card">
                        <small>Peak Period</small>
                        <strong>${startHour} - ${endHour}</strong>
                    </div>
                    <div class="report-stat-card">
                        <small>Peak Throughput</small>
                        <strong>${(rh.trips || 0).toLocaleString()} trips/hr</strong>
                    </div>
                    <div class="report-stat-card">
                        <small>Peak Avg Speed</small>
                        <strong>${rh.avgSpeed} MPH</strong>
                    </div>
                `;
            }

            // Congestion alert
            const congestionAlert = document.getElementById('reportCongestionAlert');
            if (congestionAlert && rh) {
                if (data.metadata.isCitywide && rh.congestionImpact !== null) {
                    const color = rh.congestionImpact < -15 ? "#cf222e" : "#f0883e";
                    const label = rh.congestionImpact < -15 ? "CRITICAL CONGESTION" : "HEAVY TRAFFIC";
                    congestionAlert.innerHTML = `
                        <div class="report-stat-card" style="border-left: 4px solid ${color};">
                            <strong style="color: ${color};">${label}</strong>
                            <p style="margin:0; font-size:0.85rem; color:#57606a;">
                                Peak mobility speed is <strong>${Math.abs(rh.congestionImpact)}% lower</strong> than daily average.
                            </p>
                        </div>
                    `;
                } else {
                    congestionAlert.innerHTML = "";
                }
            }

            // Populate coverage gaps
            const gapsList = document.getElementById('reportGaps');
            if (gapsList) {
                const displayGaps = (data.metadata.boroughMetadata && data.metadata.boroughMetadata.underservedZones)
                    ? data.metadata.boroughMetadata.underservedZones
                    : data.coverageGaps;

                if (displayGaps && displayGaps.length > 0) {
                    gapsList.innerHTML = displayGaps.map(g => `
                        <div class="report-stat-card" style="margin-bottom: 0.5rem; border-left: 4px solid #f0883e;">
                            <strong>${g.zone} (${g.borough || data.metadata.scope})</strong>
                            <p style="margin:0; font-size:0.85rem; color:#57606a;">
                                ${g.ratio ? `Drop-offs exceed pick-ups by ${g.ratio}x.` : 'Underserved transit area.'}
                            </p>
                        </div>
                    `).join('');
                } else {
                    gapsList.innerHTML = "<p>No critical coverage gaps detected.</p>";
                }
            }

            // Populate noise analysis
            const noiseList = document.getElementById('reportNoise');
            if (noiseList && data.summary && data.summary.anomalyDetails) {
                const noiseItems = [];
                if (data.summary.anomalyDetails.speed > 0) {
                    noiseItems.push({
                        title: `Speed Violations (${data.summary.anomalyDetails.speed})`,
                        desc: "Trips with recorded velocity exceeding physical thresholds (e.g. >80 MPH in city grid)."
                    });
                }
                if (data.summary.anomalyDetails.fare > 0) {
                    noiseItems.push({
                        title: `Suspicious Fare/Distance (${data.summary.anomalyDetails.fare})`,
                        desc: "Short trips (< 1 mi) with disproportionate meter charges (> $100)."
                    });
                }

                if (noiseItems.length > 0) {
                    noiseList.innerHTML = noiseItems.map(n => `
                        <div class="report-stat-card" style="margin-bottom: 0.5rem; border-left: 4px solid #cf222e;">
                            <strong>${n.title}</strong>
                            <p style="margin:0; font-size:0.85rem; color:#57606a;">${n.desc}</p>
                        </div>
                    `).join('');
                } else {
                    noiseList.innerHTML = "<p>No significant data noise detected.</p>";
                }
            }

            // Render rush hour chart in report
            if (rh && rh.trend) {
                renderReportChart(rh);
            }

            // Show modal
            if (reportModal) reportModal.classList.add('open');

        } catch (err) {
            console.error("Report generation error:", err);
            alert("Failed to generate report. Please check configuration.");
        } finally {
            if (generateReportBtn) {
                generateReportBtn.disabled = false;
                generateReportBtn.textContent = "Generate Report";
            }
        }
    }

    // Render rush hour trend chart
    function renderReportChart(rushHourData) {
        const canvas = document.getElementById('reportRushHourChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        if (reportChartInstance) {
            reportChartInstance.destroy();
        }

        const trend = rushHourData.trend;
        const hours = Object.keys(trend);
        const counts = Object.values(trend).map(d => d.trips);
        const peakHour = rushHourData.hour;

        reportChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: hours.map(h => `${h.padStart(2, '0')}:00`),
                datasets: [{
                    label: 'Hourly Throughput',
                    data: counts,
                    backgroundColor: hours.map(h => parseInt(h) === peakHour ? '#f0883e' : '#e1e4e8'),
                    borderColor: hours.map(h => parseInt(h) === peakHour ? '#f0883e' : '#d1d5da'),
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#f0f0f0' },
                        ticks: { color: '#57606a', font: { size: 10 } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#57606a', font: { size: 10 } }
                    }
                }
            }
        });
    }

    // Event listeners
    if (generateReportBtn) {
        generateReportBtn.addEventListener('click', generateReport);
    }

    if (closeReportBtn && reportModal) {
        closeReportBtn.addEventListener('click', () => reportModal.classList.remove('open'));
    }

    if (printReportBtn) {
        printReportBtn.addEventListener('click', () => window.print());
    }

    if (reportModal) {
        reportModal.addEventListener('click', (e) => {
            if (e.target === reportModal) reportModal.classList.remove('open');
        });
    }
});
