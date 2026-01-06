const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // --- CORRECCIÓN 1: Aumentamos la paciencia a 90 segundos (antes 30) ---
        page.setDefaultNavigationTimeout(90000);
        page.setDefaultTimeout(90000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // --- CORRECCIÓN 2: Usamos 'domcontentloaded' que es más rápido y falla menos ---
        console.log('Cargando página de login...');
        await page.goto('https://gw.defontana.com/login', { waitUntil: 'domcontentloaded' });

        // Esperamos explícitamente al input de correo
        await page.waitForSelector('input[formcontrolname="email"]');
        
        // Escribimos credenciales
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        // Click y esperamos navegación
        console.log('Enviando credenciales...');
        await Promise.all([
            page.click('button.df-primario'),
            // Esperamos solo a que el HTML cargue, no a que termine toda la red
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }) 
        ]);
        
        console.log('Login completado. Buscando botón ERP...');

        // 2. SALTAR A "ERP DIGITAL" (NUEVA PESTAÑA)
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        // Preparamos la captura de la nueva pestaña
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        await erpButton.click();
        console.log('Click en ERP Digital, esperando nueva pestaña...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        // --- Aplicamos la misma paciencia a la nueva pestaña ---
        if (!erpPage) throw new Error("No se pudo abrir la pestaña del ERP");
        erpPage.setDefaultNavigationTimeout(90000);
        erpPage.setDefaultTimeout(90000);
        
        await erpPage.setViewport({ width: 1920, height: 1080 });
        // Esperamos a que la nueva pestaña cargue su contenido
        await erpPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
        
        console.log('Pestaña ERP cargada. Navegando al menú...');

        // 3. NAVEGACIÓN DIRECTA (Truco para saltar clics)
        // Intentamos esperar a que el menú lateral exista antes de interactuar
        const menuInventarioXpath = "//span[contains(@class, 'menu-title') and contains(text(), 'Inventario')]";
        await erpPage.waitForXPath(menuInventarioXpath);
        const [btnInventario] = await erpPage.$x(menuInventarioXpath);
        
        // Usamos evaluate para hacer click click (más robusto en Angular)
        await erpPage.evaluate(el => el.click(), btnInventario);
        
        // Espera breve
        await new Promise(r => setTimeout(r, 1000));

        const menuArticulosXpath = "//span[contains(@class, 'menu-title') and contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(menuArticulosXpath);
        const [btnArticulos] = await erpPage.$x(menuArticulosXpath);
        await erpPage.evaluate(el => el.click(), btnArticulos);

        console.log('Entrando a Artículos...');

        // 4. BÚSQUEDA DEL PRODUCTO
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        await erpPage.waitForSelector(searchInputSelector);
        
        // Borramos lo que haya y escribimos
        await erpPage.evaluate((sel) => document.querySelector(sel).value = "", searchInputSelector);
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        console.log(`Buscando: ${skuLimpio}`);

        // Esperamos resultados (damos tiempo extra por si Defontana es lento buscando)
        // Esperamos a que aparezca la tabla o pasen 5 segundos
        try {
            await erpPage.waitForSelector('.mat-column-id', { timeout: 8000 });
        } catch (e) {
            console.log('Esperando resultados...');
        }

        // 5. EXTRACCIÓN
        const resultado = await erpPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                // Comparación flexible (contiene) o exacta
                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR EN SERVIDOR:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
